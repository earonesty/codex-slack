import type { LocalAttachment } from './attachments.ts';
import { Agent, type AgentThread, type CodexPermissions } from './agent.ts';
import { record } from './config.ts';
import type { AgentOptions } from './config.ts';
import { Rpc } from './rpc.ts';

export type CodexThread = AgentThread;

export class Codex extends Agent {
  readonly name = 'Codex';
  readonly capabilities = { threadDiscovery: true, interactiveRequests: true };
  private loaded = new Set<string>();
  private explicitPermissions = new Map<string, CodexPermissions>();
  private recycleTimer?: NodeJS.Timeout;
  readonly active = new Map<string, string>();
  constructor(readonly rpc: Rpc, private idleRecycleMs = 60_000) {
    super();
    rpc.on('disconnect', () => {
      if (this.recycleTimer) clearTimeout(this.recycleTimer);
      this.recycleTimer = undefined;
      this.loaded.clear(); this.active.clear();
    });
    rpc.on('notification', (method: string, params: Record<string, unknown>) => {
      const thread = String(params.threadId ?? '');
      if (method === 'turn/started') {
        if (this.recycleTimer) clearTimeout(this.recycleTimer);
        this.recycleTimer = undefined;
        this.active.set(thread, String(record(params.turn).id));
      }
      if (method === 'turn/completed' && this.active.get(thread) === record(params.turn).id) {
        this.active.delete(thread);
        if (!this.active.size) this.scheduleRecycle();
      }
    });
    rpc.on('notification', (method, params) => this.emit('notification', method, params));
    rpc.on('request', request => this.emit('request', request));
    rpc.on('disconnect', error => this.emit('disconnect', error));
  }
  private scheduleRecycle(): void {
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = undefined;
      if (this.active.size || this.rpc.recycle()) return;
      // A short non-turn request overlapped the timer. Try again once it settles.
      this.scheduleRecycle();
    }, this.idleRecycleMs);
    this.recycleTimer.unref();
  }
  start(): Promise<void> { return this.rpc.start(); }
  async check(): Promise<void> {
    await this.rpc.start();
    const account = record(record(await this.rpc.request('account/read', {})).account);
    if (!Object.keys(account).length) throw new Error('Codex is not logged in. Run codex login first.');
  }
  close(): void {
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.recycleTimer = undefined;
    this.rpc.close();
  }
  respond(id: string | number, result: unknown): void { this.rpc.respond(id, result); }
  reject(id: string | number, message: string): void { this.rpc.reject(id, message); }
  async create(cwd: string, options: AgentOptions = {}): Promise<string> {
    await this.rpc.start();
    // The scheduler supplies its global/per-job permissions explicitly.
    // Ordinary sessions inherit Codex settings.
    const result = record(await this.rpc.request('thread/start', { cwd,
      ...(options.unattended ? { sandbox: options.sandbox ?? 'workspace-write', approvalPolicy: options.approvalPolicy ?? 'on-request' } : {}),
      ...options.codexPermissions,
    }));
    const id = record(result.thread).id;
    if (typeof id !== 'string') throw new Error('Codex returned no thread ID');
    this.loaded.add(id);
    if (options.codexPermissions) this.explicitPermissions.set(id, { ...options.codexPermissions });
    return id;
  }
  private async permissions(cwd: string, options: AgentOptions = {}) {
    // Read project/user configuration, not settings persisted by the scheduled turn.
    const config = options.unattended ? {} : record(record(await this.rpc.request('config/read', { cwd })).config);
    const sandbox = options.codexPermissions?.sandbox ?? (options.unattended ? options.sandbox ?? 'workspace-write' : config.sandbox_mode ?? 'workspace-write');
    const workspace = record(config.sandbox_workspace_write);
    const sandboxPolicy = sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: workspace.writable_roots ?? [],
        networkAccess: workspace.network_access ?? false, excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var ?? false,
        excludeSlashTmp: workspace.exclude_slash_tmp ?? false };
    return { sandbox, sandboxPolicy,
      approvalPolicy: options.codexPermissions?.approvalPolicy ?? (options.unattended ? options.approvalPolicy ?? 'on-request' : config.approval_policy ?? 'on-request'),
      ...(config.approvals_reviewer ? { approvalsReviewer: config.approvals_reviewer } : {}) };
  }
  async resume(thread: string, cwd?: string): Promise<void> {
    await this.rpc.start();
    if (this.loaded.has(thread)) return;
    const permissions = await this.permissions(cwd ?? (await this.read(thread)).cwd, { codexPermissions: this.explicitPermissions.get(thread) });
    await this.resumeWithPermissions(thread, permissions);
  }
  private async resumeWithPermissions(thread: string, permissions: Awaited<ReturnType<Codex['permissions']>>): Promise<void> {
    if (this.loaded.has(thread)) return;
    const { sandboxPolicy: _sandboxPolicy, ...overrides } = permissions;
    // Explicitly restore the pair: Codex resume can retain `never` while dropping full access.
    const result = record(await this.rpc.request('thread/resume', { threadId: thread, ...overrides }));
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
  async input(thread: string, cwd: string, text: string, files: LocalAttachment[] = [], options: AgentOptions = {}): Promise<void> {
    await this.rpc.start();
    const permissions = await this.permissions(cwd, { ...options, codexPermissions: options.codexPermissions ?? this.explicitPermissions.get(thread) });
    await this.resumeWithPermissions(thread, permissions);
    const turn = this.active.get(thread);
    const descriptions = files.length ? '\n\nAttached files (local copies; read them as needed):\n'
      + files.map(file => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join('\n') : '';
    const input = [
      { type: 'text', text: (text.trim() ? text : 'Please inspect the attached files.') + descriptions },
      ...files.filter(file => file.image).map(file => ({ type: 'localImage', path: file.path })),
    ];
    // No retry on an uncertain acknowledgement: starting another turn could duplicate work.
    if (turn) await this.rpc.request('turn/steer', { threadId: thread, expectedTurnId: turn, input });
    else {
      const { sandbox: _sandbox, ...overrides } = permissions;
      await this.rpc.request('turn/start', { threadId: thread, input, ...overrides });
    }
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
