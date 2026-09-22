import { AttachmentError, type Attachment, type LocalAttachment } from './attachments.ts';
import type { Config } from './config.ts';
import { allowedDirectory, authorized, record } from './config.ts';
import { Agent, AgentError } from './agent.ts';
import { Interactions } from './interactions.ts';
import { chunks, textMessage, type Message } from './messages.ts';
import type { ServerRequest } from './rpc.ts';
import { Store, type Binding, type Incoming } from './store.ts';
import { ThreadStatus } from './thread-status.ts';
import type { KnownBlock } from '@slack/types';

export class ThreadCommandError extends Error {}

export class Bridge {
  readonly interactions: Interactions;
  scheduledEvents?: {
    notification(method: string, params: Record<string, unknown>): Promise<boolean>;
    request(request: ServerRequest): Promise<void>;
  };
  private events = new Map<string, Promise<void>>();
  private event(thread: string, action: () => Promise<void>): void {
    const pending = (this.events.get(thread) ?? Promise.resolve()).then(action)
      .catch(() => console.error(`Could not process a ${this.agent.name} event`));
    this.events.set(thread, pending);
    void pending.finally(() => { if (this.events.get(thread) === pending) this.events.delete(thread); });
  }
  private queues = new Map<string, Promise<void>>();
  private scheduled = new Set<string>();
  private outputRunning = false;
  private stopped = false;
  private running = new Set<string>();
  private status: ThreadStatus;
  constructor(readonly config: Config, readonly store: Store, readonly agent: Agent,
    private post: (binding: Binding, message: Message) => Promise<void>,
    setStatus: (binding: Binding, status: string) => Promise<void> = async () => {},
    private prepareAttachments: (files: Attachment[]) => Promise<LocalAttachment[]> = async () => {
      throw new AttachmentError('Attachment downloads are not configured. Restart the updated bridge and resend.');
    }) {
    this.status = new ThreadStatus(setStatus);
    this.interactions = new Interactions(agent, store);
    agent.on('notification', (method: string, params: Record<string, unknown>) => {
      if (this.scheduledEvents) {
        this.event(String(params.threadId ?? ''), async () => {
          if (!await this.scheduledEvents!.notification(method, params)) this.notification(method, params);
        });
      } else {
        try { this.notification(method, params); }
        catch { console.error(`Could not record a ${this.agent.name} notification`); }
      }
    });
    agent.on('request', (request: ServerRequest) => {
      const receive = async () => {
        try {
          await this.scheduledEvents?.request(request);
          const binding = this.store.byThread(String(record(request.params).threadId ?? ''));
          if (binding && !this.enabled(binding)) { agent.reject(request.id, 'Channel binding is disabled'); return; }
          this.interactions.receive(request);
        }
        catch {
          agent.reject(request.id, 'Bridge could not display the request');
          console.error(`Could not display a ${agent.name} request`);
        }
        await this.flush();
      };
      if (this.scheduledEvents) this.event(String(request.params.threadId ?? ''), receive);
      else void receive();
    });
    agent.on('disconnect', () => {
      void this.status.clear();
      this.interactions.clear();
      if (!this.stopped) for (const thread of this.running) {
        const binding = this.store.byThread(thread);
        if (binding) this.say(binding.key, `The ${agent.name} connection ended during work. Your session is saved; send !status before continuing. Work was not automatically restarted.`);
      }
      this.running.clear();
      void this.flush();
      // Session IDs remain durable; next input resumes via the public protocol.
    });
  }
  start(): void { this.store.recover(this.agent.name); this.drain(); void this.flush(); }
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
      try { await this.agent.interrupt(thread); }
      catch { console.error('Could not confirm interruption of disabled channel work.'); }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.status.clear();
    this.agent.close();
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
    const files = Array.isArray(event.files) ? event.files.map(file => ({ id: String(record(file).id ?? '') })) : [];
    const unsupported = false;
    if (!text.trim() && !files.length) return false;
    const key = `${String(team)}:${channel}:${root}`;
    const added = this.store.ingest({ id: `${String(team)}:${channel}:${event.ts}`, key, channel, root,
      cwd: this.config.channels[channel]!.cwd, thread: null, user: String(event.user), text, unsupported, files });
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
        throw new AttachmentError('This attachment was received by an older bridge without file metadata. Resend the message with its attachments.');
      } else if (!message.files?.length && message.text.trim() === '!help') {
        this.say(binding.key, `Top-level messages start ${this.agent.name} sessions; thread replies continue or steer them. Commands: ${this.agent.capabilities.threadDiscovery ? '!threads lists saved conversations for this channel\'s project; !thread <UUID> connects one; ' : ''}!status, !stop, !help. Use !bind in an unbound channel to choose its directory.`);
      } else if (!message.files?.length && message.text.trim() === '!threads') {
        await this.listThreads(binding);
      } else if (!message.files?.length && /^!thread(?:\s|$)/.test(message.text.trim())) {
        const thread = message.text.trim().slice('!thread'.length).trim();
        if (!thread) throw new ThreadCommandError('Usage: !thread <UUID>');
        await this.connectThread(binding, thread);
      } else if (!message.files?.length && message.text.trim() === '!status') {
        this.say(binding.key, binding.thread ? await this.agent.status(binding.thread, binding.cwd) : `No ${this.agent.name} session yet. Directory: ${binding.cwd}`);
      } else if (!message.files?.length && message.text.trim() === '!stop') {
        const interrupted = binding.thread && await this.agent.interrupt(binding.thread);
        this.say(binding.key, interrupted ? 'Interruption requested.' : 'No active turn to interrupt.');
      } else {
        const files = message.files?.length ? await this.prepareAttachments(message.files) : [];
        if (this.stopped || !this.enabled(binding)) { this.store.mark(message.id, 'failed'); return; }
        if (!binding.thread) {
          binding.thread = await this.agent.create(binding.cwd);
          this.store.bind(binding.key, binding.thread);
          this.say(binding.key, `Session started in ${binding.cwd}`);
        }
        if (!this.enabled(binding)) { this.store.mark(message.id, 'failed'); return; }
        await this.agent.input(binding.thread, binding.cwd, message.text, files);
      }
      this.store.mark(message.id, 'done');
    } catch (error) {
      this.store.mark(message.id, error instanceof AgentError || error instanceof AttachmentError || error instanceof ThreadCommandError ? 'failed' : 'uncertain');
      // Protocol errors may contain shell output, secrets, or private paths; keep logs generic.
      this.say(binding.key, error instanceof ThreadCommandError ? error.message : error instanceof AttachmentError
        ? `${error.message} This message was not sent to ${this.agent.name}.`
        : error instanceof AgentError
        ? `${this.agent.name} rejected this instruction. It was not retried and the session binding was preserved. Use !status, then send a new instruction when ready.`
        : `Could not confirm delivery to ${this.agent.name}. This instruction may have been accepted; it was not resent. Use !status before continuing.`);
    }
    await this.flush();
  }
  private threadLabel(thread: { name?: string; preview?: string }): string {
    const value = thread.name || thread.preview?.split('\n')[0] || '(untitled)';
    return value.length > 100 ? `${value.slice(0, 97)}...` : value;
  }
  private async listThreads(binding: Binding): Promise<void> {
    if (!this.agent.capabilities.threadDiscovery) throw new ThreadCommandError(`${this.agent.name} session discovery is not available through this driver.`);
    let result;
    try { result = await this.agent.list(binding.cwd); }
    catch { throw new ThreadCommandError(`Could not list saved ${this.agent.name} sessions. Try again in a moment.`); }
    if (!result.threads.length) { this.say(binding.key, `No saved ${this.agent.name} sessions found for ${binding.cwd}.`); return; }
    for (let offset = 0; offset < result.threads.length; offset += 20) {
      const page = result.threads.slice(offset, offset + 20);
      const blocks: KnownBlock[] = [{ type: 'header', text: { type: 'plain_text', text: offset ? `More ${this.agent.name} sessions` : `Saved ${this.agent.name} sessions` } }];
      const lines: string[] = [];
      for (const thread of page) {
        const existing = this.store.byThread(thread.id);
        const timestamp = thread.updatedAt ?? thread.createdAt;
        const when = timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'unknown time';
        const detail = `${this.threadLabel(thread)}\n${thread.id} · ${when}${existing ? ' · already connected' : ''}`;
        lines.push(detail);
        const accessory = !binding.thread && !existing ? { type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'Connect' }, action_id: 'tc:connect',
          value: this.store.addThreadChoice(binding.key, thread.id) } : undefined;
        blocks.push({ type: 'section', text: { type: 'plain_text', text: detail }, ...(accessory ? { accessory } : {}) });
      }
      if (offset === 0 && binding.thread) blocks.splice(1, 0, { type: 'context', elements: [{ type: 'plain_text', text: 'This Slack conversation is already connected. Start a new top-level !threads message to use Connect.' }] });
      if (offset + page.length === result.threads.length && result.more) blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: 'Showing the 100 most recently updated threads.' }] });
      this.store.enqueue(binding.key, { text: lines.join('\n\n'), blocks });
    }
  }
  private async checkedThread(binding: Binding, threadId: string) {
    let thread;
    try { thread = await this.agent.read(threadId); }
    catch { throw new ThreadCommandError(`No saved ${this.agent.name} session matched that UUID. Run !threads to choose one.`); }
    if (thread.cwd !== binding.cwd) throw new ThreadCommandError(`That ${this.agent.name} session belongs to a different project. Run !threads in its project channel.`);
    const existing = this.store.byThread(thread.id);
    if (existing && existing.key !== binding.key) throw new ThreadCommandError(`That ${this.agent.name} session is already connected in <#${existing.channel}>.`);
    if (this.agent.active.has(thread.id) && !existing) throw new ThreadCommandError(`That ${this.agent.name} session is currently active. Stop its work before connecting it here.`);
    return thread;
  }
  private async connectThread(binding: Binding, threadId: string): Promise<void> {
    if (binding.thread) throw new ThreadCommandError(`This Slack conversation is already connected to ${binding.thread}. Start a new top-level message to connect another thread.`);
    const thread = await this.checkedThread(binding, threadId);
    try { this.store.bind(binding.key, thread.id); }
    catch { throw new ThreadCommandError(`That ${this.agent.name} session was connected elsewhere before this request completed. Run !threads again.`); }
    binding.thread = thread.id;
    this.say(binding.key, `Connected to ${this.agent.name} session ${thread.id}. Reply here to continue: ${this.threadLabel(thread)}`);
  }
  async connectChoice(token: string, team: unknown, user: unknown, channel: unknown): Promise<string> {
    const choice = this.store.threadChoice(token);
    const binding = choice && this.store.get(choice.key);
    if (!choice || !binding) throw new ThreadCommandError('This thread choice has expired. Run !threads again.');
    if (!authorized(this.config, team, user, channel) || binding.channel !== channel || !this.enabled(binding)) {
      throw new ThreadCommandError('You are not authorized to connect this thread.');
    }
    if (binding.thread) throw new ThreadCommandError(`This Slack conversation is already connected to a ${this.agent.name} session.`);
    const thread = await this.checkedThread(binding, choice.thread);
    let connected: Binding;
    try { connected = this.store.bindChoice(token); }
    catch (error) {
      const message = error instanceof Error && error.message.startsWith('This Slack conversation')
        ? error.message : `That ${this.agent.name} session was connected elsewhere before this request completed. Run !threads again.`;
      throw new ThreadCommandError(message);
    }
    this.say(connected.key, `Connected to ${this.agent.name} session ${thread.id}. Reply here to continue: ${this.threadLabel(thread)}`);
    await this.flush();
    return `Connected to ${thread.id}.`;
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
      if (method === 'turn/started') void this.agent.interrupt(thread).catch(() => console.error('Could not interrupt disabled channel work.'));
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
        this.say(binding.key, turn.status === 'failed' ? `${this.agent.name} turn failed. Use !status to inspect the session.` : `${this.agent.name} turn interrupted.`, `${thread}:${String(turn.id)}:status`);
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
