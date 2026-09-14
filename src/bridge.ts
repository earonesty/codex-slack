import type { Config } from './config.ts';
import { allowedDirectory, authorized, record } from './config.ts';
import { Codex } from './codex.ts';
import { Interactions } from './interactions.ts';
import { chunks, textMessage, type Message } from './messages.ts';
import { RpcError, type ServerRequest } from './rpc.ts';
import { Store, type Binding, type Incoming } from './store.ts';
import { ThreadStatus } from './thread-status.ts';

export class Bridge {
  readonly interactions: Interactions;
  scheduledEvents?: {
    notification(method: string, params: Record<string, unknown>): Promise<boolean>;
    request(request: ServerRequest): Promise<void>;
  };
  private events = new Map<string, Promise<void>>();
  private event(thread: string, action: () => Promise<void>): void {
    const pending = (this.events.get(thread) ?? Promise.resolve()).then(action)
      .catch(() => console.error('Could not process a Codex event'));
    this.events.set(thread, pending);
    void pending.finally(() => { if (this.events.get(thread) === pending) this.events.delete(thread); });
  }
  private queues = new Map<string, Promise<void>>();
  private scheduled = new Set<string>();
  private outputRunning = false;
  private stopped = false;
  private running = new Set<string>();
  private status: ThreadStatus;
  constructor(readonly config: Config, readonly store: Store, readonly codex: Codex,
    private post: (binding: Binding, message: Message) => Promise<void>,
    setStatus: (binding: Binding, status: string) => Promise<void> = async () => {}) {
    this.status = new ThreadStatus(setStatus);
    this.interactions = new Interactions(codex.rpc, store);
    codex.rpc.on('notification', (method: string, params: Record<string, unknown>) => {
      if (this.scheduledEvents) {
        this.event(String(params.threadId ?? ''), async () => {
          if (!await this.scheduledEvents!.notification(method, params)) this.notification(method, params);
        });
      } else {
        try { this.notification(method, params); }
        catch { console.error('Could not record a Codex notification'); }
      }
    });
    codex.rpc.on('request', (request: ServerRequest) => {
      const receive = async () => {
        try {
          await this.scheduledEvents?.request(request);
          const binding = this.store.byThread(String(record(request.params).threadId ?? ''));
          if (binding && !this.enabled(binding)) { codex.rpc.reject(request.id, 'Channel binding is disabled'); return; }
          this.interactions.receive(request);
        }
        catch {
          codex.rpc.reject(request.id, 'Bridge could not display the request');
          console.error('Could not display a Codex request');
        }
        await this.flush();
      };
      if (this.scheduledEvents) this.event(String(request.params.threadId ?? ''), receive);
      else void receive();
    });
    codex.rpc.on('disconnect', () => {
      void this.status.clear();
      this.interactions.clear();
      if (!this.stopped) for (const thread of this.running) {
        const binding = this.store.byThread(thread);
        if (binding) this.say(binding.key, 'The Codex connection ended during work. Your session is saved; send !status before continuing. Work was not automatically restarted.');
      }
      this.running.clear();
      void this.flush();
      // Session IDs remain durable; next input resumes via the public protocol.
    });
  }
  start(): void { this.store.recover(); this.drain(); void this.flush(); }
  enabled(binding: Binding): boolean {
    if (this.store.disabled(binding.key) || binding.key.split(':')[0] !== this.config.teamId || !this.config.channels[binding.channel]) return false;
    if (Object.entries(this.config.channels).some(([channel, value]) => channel !== binding.channel && value.cwd === binding.cwd)) return false;
    try { allowedDirectory(this.config.root, binding.cwd); }
    catch { return false; }
    return true;
  }
  async disableChannels(channels: string[]): Promise<void> {
    for (const thread of this.running) {
      const binding = this.store.byThread(thread);
      if (!binding || !channels.includes(binding.channel)) continue;
      this.status.set(binding, false);
      this.interactions.clear(thread);
      try { await this.codex.interrupt(thread); }
      catch { console.error('Could not confirm interruption of disabled channel work.'); }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.status.clear();
    this.codex.rpc.close();
    await Promise.allSettled([...this.queues.values(), ...this.events.values()]);
  }
  ingest(team: unknown, value: unknown): boolean {
    const event = record(value);
    if (!authorized(this.config, team, event.user, event.channel) || event.bot_id || event.bot_profile || event.hidden) return false;
    if (event.subtype && event.subtype !== 'file_share') return false;
    if (typeof event.ts !== 'string' || !/^\d+\.\d+$/.test(event.ts)) return false;
    const channel = String(event.channel);
    const root = typeof event.thread_ts === 'string' ? event.thread_ts : event.ts;
    if (!/^\d+\.\d+$/.test(root)) return false;
    const text = typeof event.text === 'string' ? event.text : '';
    const unsupported = Array.isArray(event.files) && event.files.length > 0;
    if (!text.trim() && !unsupported) return false;
    const key = `${String(team)}:${channel}:${root}`;
    const added = this.store.ingest({ id: `${String(team)}:${channel}:${event.ts}`, key, channel, root,
      cwd: this.config.channels[channel]!.cwd, thread: null, user: String(event.user), text, unsupported });
    if (added) this.drain();
    return added;
  }
  private drain(): void {
    if (this.stopped) return;
    for (const message of this.store.pending()) {
      if (this.scheduled.has(message.id)) continue;
      this.scheduled.add(message.id);
      const previous = this.queues.get(message.key) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(() => this.dispatch(message)).finally(() => {
        this.scheduled.delete(message.id);
        if (this.queues.get(message.key) === next) this.queues.delete(message.key);
      });
      this.queues.set(message.key, next);
      void next.catch(() => console.error('Failed to persist message processing state'));
    }
  }
  private async dispatch(message: Incoming): Promise<void> {
    if (this.stopped) return;
    this.store.mark(message.id, 'dispatching');
    const binding = this.store.get(message.key)!;
    try {
      if (!this.enabled(binding) || !authorized(this.config, message.key.split(':')[0], message.user, binding.channel)) {
        this.store.mark(message.id, 'failed'); return;
      }
      if (message.unsupported) {
        this.say(binding.key, 'Attachments are not supported in version 0.1. Paste the relevant text; this message was not sent to Codex.');
      } else if (message.text.trim() === '!help') {
        this.say(binding.key, 'Top-level messages start Codex sessions; thread replies continue or steer them. Commands: !status, !stop, !help. Use !bind in an unbound channel to choose its directory. A new top-level message starts fresh.');
      } else if (message.text.trim() === '!status') {
        this.say(binding.key, binding.thread ? await this.codex.status(binding.thread) : `No Codex session yet. Directory: ${binding.cwd}`);
      } else if (message.text.trim() === '!stop') {
        const interrupted = binding.thread && await this.codex.interrupt(binding.thread);
        this.say(binding.key, interrupted ? 'Interruption requested.' : 'No active turn to interrupt.');
      } else {
        if (!binding.thread) {
          binding.thread = await this.codex.create(binding.cwd);
          this.store.bind(binding.key, binding.thread);
          this.say(binding.key, `Session started in ${binding.cwd}`);
        }
        if (!this.enabled(binding)) { this.store.mark(message.id, 'failed'); return; }
        await this.codex.input(binding.thread, message.text);
      }
      this.store.mark(message.id, 'done');
    } catch (error) {
      this.store.mark(message.id, error instanceof RpcError ? 'failed' : 'uncertain');
      // Protocol errors may contain shell output, secrets, or private paths; keep logs generic.
      this.say(binding.key, error instanceof RpcError
        ? 'Codex rejected this instruction. It was not retried and the session binding was preserved. Use !status, then send a new instruction when ready.'
        : 'Could not confirm delivery to Codex. This instruction may have been accepted; it was not resent. Use !status before continuing.');
    }
    await this.flush();
  }
  private notification(method: string, params: Record<string, unknown>): void {
    const thread = String(params.threadId ?? '');
    if (method === 'turn/started') this.running.add(thread);
    if (method === 'turn/completed') this.running.delete(thread);
    if (method === 'serverRequest/resolved') this.interactions.resolved(params.requestId, thread);
    if (method === 'item/started') this.interactions.observe(thread, String(params.turnId), record(params.item));
    const binding = this.store.byThread(thread);
    if (!binding) return;
    if (method === 'turn/completed') this.status.set(binding, false);
    if (!this.enabled(binding)) {
      this.interactions.clear(thread);
      if (method === 'turn/started') void this.codex.interrupt(thread).catch(() => console.error('Could not interrupt disabled channel work.'));
      return;
    }
    if (method === 'turn/started' && !this.stopped) this.status.set(binding, true);
    if (method === 'item/completed') {
      const item = record(params.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        this.say(binding.key, item.text, `${thread}:${String(params.turnId)}:${String(item.id)}`);
      }
    }
    if (method === 'turn/completed') {
      const turn = record(params.turn);
      this.interactions.clear(thread, String(turn.id));
      if (turn.status === 'failed' || turn.status === 'interrupted') {
        this.say(binding.key, turn.status === 'failed' ? 'Codex turn failed. Use !status to inspect the session.' : 'Codex turn interrupted.', `${thread}:${String(turn.id)}:status`);
      }
    }
    void this.flush();
  }
  say(key: string, text: string, id?: string): void {
    chunks(text).forEach((chunk, i) => this.store.enqueue(key, textMessage(chunk), id ? `${id}:${i}` : undefined));
  }
  async flush(): Promise<void> {
    if (this.outputRunning || this.stopped) return;
    this.outputRunning = true;
    try {
      let batch;
      while ((batch = this.store.deliveries()).length && !this.stopped) {
        for (const delivery of batch) {
          const binding = this.store.get(delivery.key);
          if (!binding || !this.enabled(binding)) { this.store.deliveryStatus(delivery.id, 'failed'); continue; }
          this.store.deliveryStatus(delivery.id, 'sending');
          try {
            await this.post(binding, JSON.parse(delivery.payload) as Message);
            this.status.afterMessage(binding);
            this.store.deliveryStatus(delivery.id, 'sent');
          } catch {
            // Don't replay an ambiguous Slack write. A user can recover via !status.
            this.store.deliveryStatus(delivery.id, 'failed');
            console.error(`Slack delivery failed; retained in outbox: ${delivery.id}`);
          }
        }
      }
    } finally { this.outputRunning = false; }
  }
}
