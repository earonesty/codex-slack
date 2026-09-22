import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { allowedDirectory, record } from './config.ts';
import type { Bridge } from './bridge.ts';
import { AgentError } from './agent.ts';
import { ScheduleStore, type Job, type Run } from './schedule-store.ts';

export function nextOccurrence(cron: string, timezone: string, after: number): number {
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  if (cron.trim().split(/\s+/).length !== 5 || /H/.test(cron)) throw new Error('Use a deterministic five-field cron expression (minute hour day month weekday).');
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after }).next().getTime();
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function overlaps(a: string, b: string): boolean { return within(a, b) || within(b, a); }
function required(raw: Record<string, unknown>, key: string, limit = 50_000): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${key}`);
  return value.trim();
}

/** Timer and local control API share the daemon's live routing and native sessions. */
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;
  constructor(readonly bridge: Bridge, readonly db: ScheduleStore,
    private postRoot: (channel: string, text: string) => Promise<string>, private now = Date.now) {
    bridge.scheduledEvents = {
      notification: (method, params) => this.notification(method, params),
      request: async request => {
        const run = db.byThread(String(request.params.threadId ?? ''));
        if (!run || run.finished !== null) return;
        const job = this.runJob(run);
        if (job?.channel) await this.ensureRoot(run);
        else db.update({ ...run, error: 'This run requested interaction without a Slack channel. Inspect its session and final output locally.' });
      },
    };
    bridge.agent.on('disconnect', () => { if (!this.stopped) void this.recover(); });
  }
  start(): void {
    void this.recover();
    this.timer = setInterval(() => { void this.tick().catch(() => console.error('Scheduler tick failed; check local run history')); }, 5_000);
    this.timer.unref();
    void this.tick().catch(() => console.error('Scheduler startup tick failed'));
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); }
  private async recover(): Promise<void> {
    for (const run of this.db.recover()) {
      await this.ensureRoot(run);
      const saved = this.db.run(run.id)!;
      if (saved.key) this.bridge.say(saved.key,
        'The bridge stopped during this scheduled run. It has not been repeated. Use !status to inspect it; the schedule is blocked until this uncertain run is resolved.', `schedule-recovery:${run.id}`);
    }
    await this.bridge.flush();
  }
  private runJob(run: Run): Job | undefined {
    return run.jobSnapshot ? JSON.parse(run.jobSnapshot) as Job : this.db.get(run.jobId);
  }
  private async ensureRoot(run: Run): Promise<boolean> {
    run = this.db.run(run.id)!;
    if (run.key) return true;
    const job = this.runJob(run);
    if (!job?.channel || run.deliveryState === 'posting' || run.deliveryState === 'uncertain') return false;
    try {
      this.valid(job);
      this.db.update({ ...run, deliveryState: 'posting' });
      const root = await this.postRoot(job.channel, `${job.name} — ${new Date(run.started).toLocaleString('en-US', { timeZone: job.timezone })} (${job.timezone})\nScheduled task: ${job.id}\nDirectory: ${job.cwd}\nReply in this thread to continue this run.`);
      if (!/^\d+\.\d+$/.test(root)) throw new Error('Slack returned no valid message timestamp');
      // Re-read: completion or a disconnect may have changed the run while Slack was responding.
      run = this.db.run(run.id)!;
      const key = `${job.team}:${job.channel}:${root}`;
      this.bridge.store.addBinding({ key, channel: job.channel, root, cwd: job.cwd, thread: run.thread });
      this.db.update({ ...run, key, deliveryState: 'posted' });
      return true;
    } catch {
      run = this.db.run(run.id)!;
      this.db.update({ ...run, status: 'uncertain', deliveryState: 'uncertain',
        error: 'Could not confirm Slack delivery. Inspect history and the session before resolving; delivery was not retried.' });
      return false;
    }
  }
  private route(cwd: string): [string, { cwd: string }] | undefined {
    return Object.entries(this.bridge.config.channels).filter(([, binding]) => within(binding.cwd, cwd))
      .sort((a, b) => b[1].cwd.length - a[1].cwd.length)[0];
  }
  put(value: unknown, contextThread?: string): Job {
    const raw = record(value);
    const id = required(raw, 'id', 80);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('id must use lowercase letters, digits, underscores or hyphens');
    const config = this.bridge.config;
    const previous = this.db.get(id);
    const cwd = allowedDirectory(config.root, required(raw, 'cwd'));
    const context = contextThread ? this.bridge.store.byThread(contextThread) : undefined;
    if (context && !this.bridge.enabled(context)) throw new Error('The source Slack thread is disabled');
    const sourceRun = contextThread ? this.db.byThread(contextThread) : undefined;
    const user = raw.user ?? previous?.user ?? (context ? this.bridge.store.owner(context.key) : undefined)
      ?? (sourceRun ? this.db.get(sourceRun.jobId)?.user : undefined)
      ?? (config.allowedUserIds.length === 1 ? config.allowedUserIds[0] : undefined);
    if (typeof user !== 'string' || !config.allowedUserIds.includes(user)) throw new Error('Specify an authorized Slack user ID in user');
    const route = this.route(cwd);
    let channel: string | null;
    if (raw.channel === null) channel = null;
    else if (raw.channel === undefined || raw.channel === 'auto') channel = route?.[0] ?? null;
    else if (typeof raw.channel === 'string' && config.channels[raw.channel]) channel = raw.channel;
    else throw new Error('channel must be auto, null, or a configured Slack channel ID');
    if (channel && (route?.[0] !== channel || !within(config.channels[channel]!.cwd, cwd))) {
      throw new Error('Use the channel that owns this directory, or channel: null for local results');
    }
    const timezone = required(raw, 'timezone', 100);
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    const cron = typeof raw.cron === 'string' && raw.cron.trim() ? raw.cron.trim() : null;
    const at = typeof raw.at === 'string' && raw.at.trim() ? raw.at.trim() : null;
    if (Boolean(cron) === Boolean(at)) throw new Error('Specify exactly one of cron or at');
    let nextAt: number;
    if (cron) nextAt = nextOccurrence(cron, timezone, this.now());
    else {
      if (!/(Z|[+-]\d{2}:\d{2})$/i.test(at!)) throw new Error('at must be an ISO timestamp with Z or a UTC offset');
      nextAt = Date.parse(at!);
      if (!Number.isFinite(nextAt) || nextAt <= this.now()) throw new Error('at must be a future timestamp');
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('enabled must be boolean');
    if (raw.verbosity !== undefined && raw.verbosity !== 'quiet' && raw.verbosity !== 'verbose') throw new Error('verbosity must be quiet or verbose');
    const job: Job = { id, name: required(raw, 'name', 200), prompt: required(raw, 'prompt'), cwd, cron, at,
      timezone, channel, channelCwd: channel ? config.channels[channel]!.cwd : null, team: config.teamId, user,
      enabled: raw.enabled as boolean ?? previous?.enabled ?? true, nextAt, verbosity: raw.verbosity as Job['verbosity'] ?? 'quiet' };
    // A retried save or prompt edit does not postpone an already scheduled occurrence.
    if (previous && previous.cron === cron && previous.at === at && previous.timezone === timezone) job.nextAt = previous.nextAt;
    return this.db.save(job);
  }
  private valid(job: Job): void {
    const config = this.bridge.config;
    if (job.team !== config.teamId || !config.allowedUserIds.includes(job.user)) throw new Error('The scheduling user or workspace is no longer authorized');
    if (allowedDirectory(config.root, job.cwd) !== job.cwd) throw new Error('The project directory changed');
    if (job.channel && (config.channels[job.channel]?.cwd !== job.channelCwd || this.route(job.cwd)?.[0] !== job.channel)) {
      throw new Error('The project channel binding changed; update this schedule to select its destination again');
    }
  }
  private busy(job: Job): boolean {
    if (this.db.active().some(run => run.jobId === job.id || overlaps(run.cwd, job.cwd))) return true;
    return [...this.bridge.agent.active.keys()].some(thread => {
      const binding = this.bridge.store.byThread(thread);
      return binding && overlaps(binding.cwd, job.cwd);
    });
  }
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const candidate of this.db.list()) {
        if (this.stopped) break;
        // Re-read after each async launch so pause/remove takes effect immediately.
        const job = this.db.get(candidate.id);
        if (job?.enabled && job.nextAt !== null && job.nextAt <= this.now()) await this.launch(job, true);
      }
    } finally { this.ticking = false; }
  }
  async launch(job: Job, scheduled = false): Promise<Run> {
    if (this.stopped) throw new Error('Scheduler is stopping');
    const run: Run = { id: randomUUID(), jobId: job.id, cwd: job.cwd, thread: null, key: null,
      status: 'starting', started: this.now(), finished: null, output: '', error: null, jobSnapshot: JSON.stringify(job), deliveryState: null };
    let invalid: string | undefined;
    try { this.valid(job); } catch (error) { invalid = error instanceof Error ? error.message : 'Invalid schedule'; }
    if (invalid) {
      job.enabled = false;
      this.db.claim(job, { ...run, status: 'failed', finished: this.now(), error: invalid });
      return this.db.run(run.id)!;
    }
    if (this.busy(job)) {
      if (!scheduled) throw new Error('Another run or uncertain result is blocking this project. Inspect history before trying again.');
      // Recurring occurrences are skipped; one-shot work waits until the folder is free.
      if (!job.cron) return { ...run, status: 'skipped', error: 'Project is busy; one-shot task remains due' };
      job.nextAt = nextOccurrence(job.cron, job.timezone, this.now());
      this.db.claim(job, { ...run, status: 'skipped', finished: this.now(), error: 'Project has active or uncertain work' });
      return this.db.run(run.id)!;
    }
    if (scheduled) {
      job.nextAt = job.cron ? nextOccurrence(job.cron, job.timezone, this.now()) : null;
      if (!job.cron) job.enabled = false;
    }
    // Advance the schedule and journal intent together, before either external side effect.
    this.db.claim(job, run);
    try {
      if (job.channel && job.verbosity === 'verbose') {
        if (!await this.ensureRoot(run)) return this.db.run(run.id)!;
        Object.assign(run, this.db.run(run.id));
      }
      this.valid(job);
      if (this.stopped) throw new Error('Scheduler stopped before session creation');
      run.thread = await this.bridge.agent.create(job.cwd, { unattended: true });
      if (run.key) this.bridge.store.bind(run.key, run.thread);
      this.db.update({ ...run, status: 'running' });
      this.valid(job);
      if (this.stopped) throw new Error('Scheduler stopped before task dispatch');
      const instruction = `${job.prompt}\n\n[Scheduled execution: ${job.id}]\nThis is one occurrence of an existing task; perform the work now. Do not create another schedule. When no action was taken, nothing changed, and no error, blocker, or question needs attention, return exactly [SILENT] as your final answer. Never use [SILENT] after an action or to hide a failure or request for judgment. Preserve the user's stated authorization and project instructions. Finish with a concise summary of findings, changes, verification, commits/deployment if requested, and any unresolved question.${job.channel ? ' Your output and questions are delivered to the linked Slack thread, where the user can reply.' : ' There is no linked Slack channel. If user judgment is required, finish with the question so it is saved in the local run history.'}`;
      await this.bridge.agent.input(run.thread, job.cwd, instruction);
      // Completion may arrive before the turn/start acknowledgement; never overwrite it here.
    } catch (error) {
      const saved = this.db.run(run.id)!;
      if (saved.status === 'starting' || saved.status === 'running') {
        this.db.update({ ...saved, status: error instanceof AgentError ? 'failed' : 'uncertain', finished: this.now(),
          error: 'Could not confirm scheduled task delivery. Inspect the session and Slack thread before resolving; it was not retried.' });
        await this.ensureRoot(saved);
        const delivered = this.db.run(run.id)!;
        if (delivered.key) this.bridge.say(delivered.key, 'Could not confirm this scheduled run. It was not repeated. Use !status to inspect the saved session.');
      }
    }
    await this.bridge.flush();
    return this.db.run(run.id)!;
  }
  private async notification(method: string, params: Record<string, unknown>): Promise<boolean> {
    let run = this.db.byThread(String(params.threadId ?? ''));
    // Only the original scheduled occurrence is quiet; human replies are normal bridge turns.
    if (!run || run.finished !== null) return false;
    const quiet = this.runJob(run)?.verbosity !== 'verbose';
    if (method === 'turn/started' && run.status !== 'uncertain') this.db.update({ ...run, status: 'running' });
    if (method === 'item/completed') {
      const item = record(params.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        if (item.phase !== 'commentary') this.db.update({ ...run, output: item.text });
        if (quiet) return true;
      }
    }
    if (method === 'turn/completed') {
      const status = record(params.turn).status;
      const meaningful = run.output.trim() !== '' && run.output.trim() !== '[SILENT]';
      const failure = status === 'failed' || status === 'interrupted' || run.status === 'uncertain';
      // Delay the first Slack write until a result, failure, or interactive request needs attention.
      if (meaningful || failure) await this.ensureRoot(run);
      run = this.db.run(run.id)!;
      if (quiet && meaningful && run.key) this.bridge.say(run.key, run.output,
        `${run.thread}:${String(record(params.turn).id)}:scheduled-final`);
      if (quiet && run.status === 'uncertain' && run.key) this.bridge.say(run.key,
        'This scheduled run needs inspection. Check !status and local history before retrying.', `${run.id}:uncertain`);
      this.db.update({ ...run, status: run.status === 'uncertain' ? 'uncertain'
        : status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed', finished: this.now() });
      await this.bridge.flush();
    }
    return false;
  }
  async command(value: unknown): Promise<unknown> {
    const raw = record(value);
    switch (raw.action) {
      case 'status': return { scheduler: 'ready', jobs: this.db.list().length, active: this.db.active().length,
        channels: this.bridge.config.channels, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      case 'list': return this.db.list();
      case 'put': return this.put(raw.job, typeof raw.contextThread === 'string' ? raw.contextThread : undefined);
      case 'history': return this.db.history(typeof raw.id === 'string' ? raw.id : undefined);
      case 'resolve': {
        const run = this.db.run(required(raw, 'id', 80));
        if (!run || run.status !== 'uncertain') throw new Error('resolve requires an uncertain run ID');
        const note = required(raw, 'note', 2000);
        if (run.thread) await this.bridge.agent.resume(run.thread, run.cwd);
        if (run.thread && this.bridge.agent.active.has(run.thread)) throw new Error('Run is still active');
        return this.db.update({ ...run, status: 'interrupted', finished: this.now(), error: `Resolved after inspection: ${note}` });
      }
      default: {
        const job = this.db.get(required(raw, 'id', 80));
        if (!job) throw new Error('Schedule not found');
        if (raw.action === 'get') return job;
        if (raw.action === 'remove') { this.db.remove(job.id); return { removed: job.id, runningWorkStopped: false }; }
        if (raw.action === 'pause') return this.db.save({ ...job, enabled: false });
        if (raw.action === 'resume') {
          this.valid(job);
          const nextAt = job.cron ? nextOccurrence(job.cron, job.timezone, this.now()) : Date.parse(job.at!);
          if (!Number.isFinite(nextAt) || nextAt <= this.now()) throw new Error('Update the one-shot task with a future at timestamp');
          return this.db.save({ ...job, enabled: true, nextAt });
        }
        if (raw.action === 'run') return this.launch(job);
        throw new Error('Unknown scheduling action');
      }
    }
  }
}
