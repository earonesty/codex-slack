import type { LocalAttachment } from './attachments.ts';
import { record } from './config.ts';
import { Rpc } from './rpc.ts';

export type CodexThread = {
  id: string;
  cwd: string;
  name?: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: { type?: string };
};

export class Codex {
  private loaded = new Set<string>();
  readonly active = new Map<string, string>();
  constructor(readonly rpc: Rpc) {
    rpc.on('disconnect', () => { this.loaded.clear(); this.active.clear(); });
    rpc.on('notification', (method: string, params: Record<string, unknown>) => {
      const thread = String(params.threadId ?? '');
      if (method === 'turn/started') this.active.set(thread, String(record(params.turn).id));
      if (method === 'turn/completed' && this.active.get(thread) === record(params.turn).id) this.active.delete(thread);
    });
  }
  async create(cwd: string, options: { unattended?: boolean } = {}): Promise<string> {
    await this.rpc.start();
    // Scheduled work needs filesystem/network access without an approval round trip.
    // Other settings, and permissions for ordinary Slack sessions, inherit Codex.
    const result = record(await this.rpc.request('thread/start', { cwd,
      ...(options.unattended ? { sandbox: 'danger-full-access', approvalPolicy: 'never' } : {}),
    }));
    const id = record(result.thread).id;
    if (typeof id !== 'string') throw new Error('Codex returned no thread ID');
    this.loaded.add(id);
    return id;
  }
  async resume(thread: string): Promise<void> {
    await this.rpc.start();
    if (this.loaded.has(thread)) return;
    const result = record(await this.rpc.request('thread/resume', { threadId: thread }));
    const turns = record(result.thread).turns;
    if (Array.isArray(turns)) {
      const turn = turns.map(record).findLast(turn => turn.status === 'inProgress');
      if (typeof turn?.id === 'string') this.active.set(thread, turn.id);
    }
    this.loaded.add(thread);
  }
  async read(thread: string): Promise<CodexThread> {
    await this.rpc.start();
    const result = record(await this.rpc.request('thread/read', { threadId: thread, includeTurns: false }));
    const data = record(result.thread);
    if (typeof data.id !== 'string' || typeof data.cwd !== 'string') throw new Error('Codex returned an invalid thread');
    return data as CodexThread;
  }
  async list(cwd: string, limit = 100): Promise<{ threads: CodexThread[]; more: boolean }> {
    await this.rpc.start();
    const result = record(await this.rpc.request('thread/list', {
      cwd, limit, sortKey: 'updated_at', sortDirection: 'desc',
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
    }));
    if (!Array.isArray(result.data)) throw new Error('Codex returned an invalid thread list');
    const threads = result.data.map(record).filter(thread => typeof thread.id === 'string' && typeof thread.cwd === 'string') as CodexThread[];
    return { threads, more: typeof result.nextCursor === 'string' && !!result.nextCursor };
  }
  async input(thread: string, text: string, files: LocalAttachment[] = []): Promise<void> {
    await this.resume(thread);
    const turn = this.active.get(thread);
    const descriptions = files.length ? '\n\nAttached files (local copies; read them as needed):\n'
      + files.map(file => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join('\n') : '';
    const input = [
      { type: 'text', text: (text.trim() ? text : 'Please inspect the attached files.') + descriptions },
      ...files.filter(file => file.image).map(file => ({ type: 'localImage', path: file.path })),
    ];
    // No retry on an uncertain acknowledgement: starting another turn could duplicate work.
    if (turn) await this.rpc.request('turn/steer', { threadId: thread, expectedTurnId: turn, input });
    else await this.rpc.request('turn/start', { threadId: thread, input });
  }
  async interrupt(thread: string): Promise<boolean> {
    await this.resume(thread);
    const turnId = this.active.get(thread);
    if (!turnId) return false;
    await this.rpc.request('turn/interrupt', { threadId: thread, turnId });
    return true;
  }
  async status(thread: string): Promise<string> {
    await this.resume(thread);
    const result = record(await this.rpc.request('thread/read', { threadId: thread, includeTurns: true }));
    const data = record(result.thread);
    const turns = Array.isArray(data.turns) ? data.turns.map(record) : [];
    const last = turns.at(-1);
    const items = Array.isArray(last?.items) ? last.items.map(record) : [];
    const answer = items.findLast(item => item.type === 'agentMessage' && item.phase === 'final_answer');
    return `Session: ${thread}\nDirectory: ${String(data.cwd ?? '')}\nStatus: ${String(record(data.status).type ?? last?.status ?? 'idle')}`
      + (answer ? `\n\nLatest answer:\n${String(answer.text)}` : '');
  }
}
