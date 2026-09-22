import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Agent, AgentError, type AgentThread } from './agent.ts';
import type { LocalAttachment } from './attachments.ts';
import { record } from './config.ts';

const execute = promisify(execFile);
type Session = {
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  buffer: string;
  turn?: string;
  stopped?: boolean;
  closing: boolean;
  closed: boolean;
  termination: Promise<void>;
  resolveTermination: () => void;
};

/** Claude Code's documented streaming CLI adapted to the bridge turn contract. */
export class Claude extends Agent {
  readonly name = 'Claude';
  readonly capabilities = { threadDiscovery: false, interactiveRequests: false };
  readonly active = new Map<string, string>();
  private sessions = new Map<string, Session>();
  private directories = new Map<string, string>();
  private fresh = new Set<string>();
  private unattended = new Set<string>();
  private answers = new Map<string, string>();
  constructor(private command: string, private commandArgs: string[] = []) { super(); }

  async start(): Promise<void> { await this.check(); }
  async check(): Promise<void> {
    let stdout: string;
    try {
      ({ stdout } = await execute(this.command, [...this.commandArgs, 'auth', 'status', '--json'], { timeout: 30_000, encoding: 'utf8' }));
    } catch { throw new AgentError('Claude is unavailable or not logged in. Run claude auth login first.'); }
    const status = record(JSON.parse(stdout));
    if (status.loggedIn !== true && status.logged_in !== true) throw new AgentError('Claude is not logged in. Run claude auth login first.');
  }
  async create(cwd: string, options: { unattended?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    this.directories.set(id, cwd); this.fresh.add(id);
    if (options.unattended) this.unattended.add(id);
    return id;
  }
  async resume(thread: string, cwd?: string): Promise<void> {
    if (cwd) this.directories.set(thread, cwd);
    if (!this.directories.has(thread)) throw new AgentError('Claude sessions require their original project directory.');
  }
  async read(_thread: string): Promise<AgentThread> {
    throw new AgentError('Claude Code does not expose noninteractive session discovery through this driver.');
  }
  async list(_cwd: string, _limit = 100): Promise<{ threads: AgentThread[]; more: boolean }> {
    throw new AgentError('Claude Code does not expose noninteractive session discovery through this driver.');
  }
  async input(thread: string, cwd: string, text: string, files: LocalAttachment[] = []): Promise<void> {
    await this.resume(thread, cwd);
    let session = this.sessions.get(thread);
    if (session?.closing) { await session.termination; session = undefined; }
    session ??= this.launch(thread, cwd);
    const descriptions = files.length ? '\n\nAttached files (local copies; read them as needed):\n'
      + files.map(file => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join('\n') : '';
    const prompt = (text.trim() ? text : 'Please inspect the attached files.') + descriptions;
    if (!session.turn) {
      session.turn = randomUUID();
      this.active.set(thread, session.turn);
      this.emit('notification', 'turn/started', { threadId: thread, turn: { id: session.turn } });
    }
    await new Promise<void>((resolve, reject) => {
      const message = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n';
      session.child.stdin.write(message, error => error ? reject(error) : resolve());
    });
  }
  async interrupt(thread: string): Promise<boolean> {
    const session = this.sessions.get(thread); const turn = this.active.get(thread);
    if (!session || !turn) return false;
    session.stopped = true; session.closing = true;
    this.complete(thread, session, 'interrupted');
    session.child.kill('SIGINT');
    await this.ensureTermination(thread, session);
    return true;
  }
  async status(thread: string, cwd?: string): Promise<string> {
    const directory = cwd ?? this.directories.get(thread) ?? '';
    const answer = this.answers.get(thread);
    return `Session: ${thread}\nDirectory: ${directory}\nStatus: ${this.active.has(thread) ? 'inProgress' : 'idle'}`
      + (answer ? `\n\nLatest answer:\n${answer}` : '');
  }
  respond(): void { throw new AgentError('Claude interactive requests are not supported by this driver.'); }
  reject(): void { throw new AgentError('Claude interactive requests are not supported by this driver.'); }

  private launch(thread: string, cwd: string): Session {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompts', 'none', '--permission-mode', this.unattended.has(thread) ? 'bypassPermissions' : 'auto'];
    if (this.unattended.has(thread)) args.push('--dangerously-skip-permissions');
    if (this.fresh.delete(thread)) args.push('--session-id', thread); else args.push('--resume', thread);
    const child = spawn(this.command, [...this.commandArgs, ...args], { cwd, stdio: 'pipe', env: process.env });
    let resolveTermination!: () => void;
    const termination = new Promise<void>(resolve => { resolveTermination = resolve; });
    const session: Session = { child, cwd, buffer: '', closing: false, closed: false, termination, resolveTermination };
    this.sessions.set(thread, session);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.output(thread, session, chunk));
    child.stderr.resume();
    child.stdin.on('error', () => this.failSession(thread, session));
    child.on('error', () => this.processClosed(thread, session, true));
    child.on('close', () => this.processClosed(thread, session, true));
    return session;
  }
  private output(thread: string, session: Session, chunk: string): void {
    if (this.sessions.get(thread) !== session) return;
    session.buffer += chunk;
    if (Buffer.byteLength(session.buffer) > 32 * 1024 * 1024) return this.failSession(thread, session);
    let end: number;
    while ((end = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, end); session.buffer = session.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = record(JSON.parse(line)); } catch { return this.failSession(thread, session); }
      if (message.type !== 'result' || !session.turn) continue;
      const text = typeof message.result === 'string' ? message.result : '';
      if (text) {
        this.answers.set(thread, text);
        this.emit('notification', 'item/completed', { threadId: thread, turnId: session.turn,
          item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text } });
      }
      this.complete(thread, session, message.is_error === true ? 'failed' : 'completed');
      if (this.unattended.delete(thread)) {
        session.stopped = true; session.closing = true; session.child.kill('SIGTERM');
        void this.ensureTermination(thread, session);
      }
    }
  }
  private failSession(thread: string, session: Session): void {
    if (session.closed || session.closing) return;
    session.closing = true;
    if (session.turn) this.complete(thread, session, 'failed');
    session.child.kill('SIGTERM');
    void this.ensureTermination(thread, session);
  }
  private processClosed(thread: string, session: Session, failed: boolean): void {
    if (session.closed) return;
    session.closed = true;
    if (failed && session.turn && !session.stopped) this.complete(thread, session, 'failed');
    if (this.sessions.get(thread) === session) this.sessions.delete(thread);
    this.unattended.delete(thread);
    session.resolveTermination();
  }
  private async ensureTermination(thread: string, session: Session): Promise<void> {
    if (session.closed) return;
    await Promise.race([session.termination, new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
    if (session.closed) return;
    session.child.kill('SIGKILL');
    await Promise.race([session.termination, new Promise<void>(resolve => setTimeout(resolve, 1_000))]);
    if (!session.closed) this.processClosed(thread, session, true);
  }
  private complete(thread: string, session: Session, status: 'completed' | 'failed' | 'interrupted'): void {
    const turn = session.turn;
    if (!turn) return;
    session.turn = undefined;
    if (this.active.get(thread) === turn) this.active.delete(thread);
    this.emit('notification', 'turn/completed', { threadId: thread, turn: { id: turn, status } });
  }
  close(): void {
    for (const [thread, session] of this.sessions) {
      session.stopped = true; session.closing = true; session.child.kill();
      this.processClosed(thread, session, false);
    }
    this.active.clear();
    this.emit('disconnect', new AgentError('Bridge stopped'));
  }
}
