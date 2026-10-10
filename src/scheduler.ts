import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { allowedDirectory, record } from './config.ts';
import type { Bridge } from './bridge.ts';
import { AgentError } from './agent.ts';
import { turnError } from './turn-error.ts';
import { ScheduleStore, type Job, type Run } from './schedule-store.ts';
import { checkCondition, type CheckCondition, type Condition } from './condition.ts';
import type { ServerRequest } from './rpc.ts';

const unattendedBrowserPolicy = `[Unattended browser policy]
Do not use the installed Codex Browser Use connector, browser-control/CUA, or connector file-download actions during this unattended occurrence. This restriction applies to that Codex connector, not to browser automation generally: interactive or headless browser sessions driven through repository-owned CDP, Playwright/Puppeteer, nodriver/Zendriver, or similar tooling are explicitly allowed, as are repository-owned scripts, APIs, and direct HTTP. Do not request Browser Use approval for those allowed approaches. If repository-native browser automation cannot complete one subtask, record the blocker and continue all independent authorized work.`;

function browserUseApproval(request: ServerRequest): boolean {
  if (request.method !== 'mcpServer/elicitation/request') return false;
  const params = record(request.params);
  const meta = record(params._meta);
  return params.serverName === 'cua_repl'
    || meta.connector_id === 'browser-use'
    || meta.connector_name === 'Browser use'
    || meta.tool_name === 'download_browser_files';
}

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
  private checks = new Map<string, AbortController>();
  private launches = new Set<string>();
  constructor(readonly bridge: Bridge, readonly db: ScheduleStore,
    private postRoot: (channel: string, text: string) => Promise<string>, private now = Date.now,
    private check: CheckCondition = checkCondition) {
    bridge.scheduledEvents = {
      notification: (method, params) => this.notification(method, params),
      request: async request => {
        const thread = String(request.params.threadId ?? '');
        const direct = db.byThread(thread);
        const run = direct?.finished === null ? direct : this.followupRun(thread);
        if (!run || run.finished !== null) return false;
        const job = this.runJob(run);
        const scheduledBrowserUse = job?.scheduledBrowserUse ?? this.bridge.config.scheduledBrowserUse;
        if (!scheduledBrowserUse && browserUseApproval(request)) {
          this.bridge.agent.respond(request.id, { action: 'decline', content: null });
          return true;
        }
        if (job?.channel) await this.ensureRoot(run);
        else db.update({ ...run, error: 'This run requested interaction without a Slack channel. Inspect its session and final output locally.' });
        return false;
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
  stop(): void {
    this.stopped = true; clearInterval(this.timer);
    for (const check of this.checks.values()) check.abort();
  }
  private async recover(): Promise<void> {
    // Follow-ups use a durable inbox ID; recover a crash between the two databases
    // by inserting the same ID, never by re-running the predicate or task.
    const retained = new Set<string>();
    for (const run of this.db.active().filter(run => run.deliveryState === 'preparing-followup' || run.deliveryState === 'queued')) {
      try {
        const job = this.runJob(run);
        if (!job?.thread) throw new Error('Missing follow-up session');
        if (run.deliveryState === 'preparing-followup') this.queueFollowup(job, run);
        if (this.bridge.store.inboxStatus(`schedule-followup:${run.id}`) !== 'pending') {
          const saved = this.db.run(run.id)!;
          this.db.update({ ...saved, status: 'uncertain',
            error: 'The bridge stopped after dispatching this scheduled follow-up. It was not replayed; inspect the existing session before resolving the run.' });
          continue;
        }
        this.bridge.wake();
        retained.add(run.id);
      } catch {
        this.db.update({ ...run, status: 'failed', finished: this.now(), error: 'Original follow-up session is no longer authorized' });
      }
    }
    for (const run of this.db.recover(retained)) {
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
  private followupRun(thread: string): Run | undefined {
    return this.db.active().find(run => {
      if (run.deliveryState !== 'queued') return false;
      return this.runJob(run)?.thread === thread;
    });
  }
  private taskPrompt(job: Job): string {
    return (job.scheduledBrowserUse ?? this.bridge.config.scheduledBrowserUse)
      ? job.prompt
      : `${job.prompt}\n\n${unattendedBrowserPolicy}`;
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
      const sessionStarted = Boolean(run.thread);
      this.db.update({ ...run, status: sessionStarted ? 'uncertain' : 'failed',
        finished: sessionStarted ? run.finished : this.now(), deliveryState: 'uncertain',
        error: sessionStarted
          ? 'Could not confirm Slack delivery. Inspect history and the session before resolving; delivery was not retried.'
          : 'Could not confirm Slack delivery before an agent session was created. No task prompt was dispatched; future occurrences remain unblocked.' });
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
    if (raw.disableOnFailure !== undefined && typeof raw.disableOnFailure !== 'boolean') throw new Error('disableOnFailure must be boolean');
    if (raw.verbosity !== undefined && raw.verbosity !== 'quiet' && raw.verbosity !== 'verbose') throw new Error('verbosity must be quiet or verbose');
    if (raw.scheduledBrowserUse !== undefined && typeof raw.scheduledBrowserUse !== 'boolean') throw new Error('scheduledBrowserUse must be boolean');
    let thread = raw.thread === 'current' ? contextThread : raw.thread;
    if (raw.thread !== undefined && (typeof thread !== 'string' || !thread)) throw new Error('thread must be current or an existing Slack-linked session ID');
    const target = typeof thread === 'string' ? this.bridge.store.byThread(thread)
      ?? this.bridge.store.get(`${config.teamId}:${channel}:${thread}`) : undefined;
    if (thread && (!target?.thread || !this.bridge.enabled(target) || target.channel !== channel || target.cwd !== cwd)) {
      throw new Error('thread must belong to the selected channel and exact task directory');
    }
    if (target) thread = target.thread;
    let condition: Condition | undefined;
    if (raw.condition !== undefined) {
      const predicate = record(raw.condition);
      const executable = required(predicate, 'executable', 4096);
      if (!path.isAbsolute(executable) || executable.includes('\0')) throw new Error('condition.executable must be an absolute path');
      const args = predicate.args ?? [];
      if (!Array.isArray(args) || args.length > 100 || args.some(a => typeof a !== 'string' || a.length > 12000 || a.includes('\0'))) throw new Error('condition.args must be an array of strings');
      const timeoutSeconds = predicate.timeoutSeconds ?? 30;
      const pollSeconds = predicate.pollSeconds ?? 300;
      if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 60) throw new Error('condition.timeoutSeconds must be 1–60');
      if (!Number.isInteger(pollSeconds) || Number(pollSeconds) < 15 || Number(pollSeconds) > 86400) throw new Error('condition.pollSeconds must be 15–86400');
      const expiresAt = predicate.expiresAt === undefined ? previous?.condition?.expiresAt ?? this.now() + 7 * 86400_000
        : typeof predicate.expiresAt === 'number' ? predicate.expiresAt
        : typeof predicate.expiresAt === 'string' && /(Z|[+-]\d{2}:\d{2})$/i.test(predicate.expiresAt) ? Date.parse(predicate.expiresAt) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('condition.expiresAt must be a future ISO timestamp with timezone');
      condition = { executable, args, timeoutSeconds: Number(timeoutSeconds), pollSeconds: Number(pollSeconds), expiresAt };
    }
    if (raw.repeat !== undefined && typeof raw.repeat !== 'boolean') throw new Error('repeat must be boolean');
    const job: Job = { id, name: required(raw, 'name', 200), prompt: required(raw, 'prompt'), cwd, cron, at,
      timezone, channel, channelCwd: channel ? config.channels[channel]!.cwd : null, team: config.teamId, user,
      enabled: raw.enabled as boolean ?? previous?.enabled ?? true, nextAt,
      disableOnFailure: raw.disableOnFailure as boolean ?? previous?.disableOnFailure ?? !cron,
      verbosity: raw.verbosity as Job['verbosity'] ?? 'quiet' };
    if (typeof raw.scheduledBrowserUse === 'boolean') job.scheduledBrowserUse = raw.scheduledBrowserUse;
    if (typeof thread === 'string') { job.thread = thread; job.threadKey = target!.key; }
    if (condition) { job.condition = condition; job.repeat = raw.repeat as boolean ?? false; }
    else if (raw.repeat !== undefined) job.repeat = raw.repeat as boolean;
    const sameDefinition = previous && ['name', 'prompt', 'cwd', 'cron', 'at', 'timezone', 'channel', 'user', 'thread', 'threadKey', 'condition', 'repeat', 'verbosity', 'disableOnFailure', 'scheduledBrowserUse']
      .every(k => JSON.stringify(previous[k as keyof Job]) === JSON.stringify(job[k as keyof Job]));
    job.revision = sameDefinition ? previous.revision : randomUUID();
    if (sameDefinition) {
      job.conditionLastChecked = previous.conditionLastChecked; job.conditionLastExit = previous.conditionLastExit; job.conditionError = previous.conditionError;
    }
    // A retried save or prompt edit does not postpone an already scheduled occurrence.
    if (previous && previous.cron === cron && previous.at === at && previous.timezone === timezone) job.nextAt = previous.nextAt;
    this.checks.get(id)?.abort();
    return this.db.save(job);
  }
  private valid(job: Job): void {
    const config = this.bridge.config;
    if (job.team !== config.teamId || !config.allowedUserIds.includes(job.user)) throw new Error('The scheduling user or workspace is no longer authorized');
    if (allowedDirectory(config.root, job.cwd) !== job.cwd) throw new Error('The project directory changed');
    if (job.channel && (config.channels[job.channel]?.cwd !== job.channelCwd || this.route(job.cwd)?.[0] !== job.channel)) {
      throw new Error('The project channel binding changed; update this schedule to select its destination again');
    }
    if (job.thread) {
      const target = this.bridge.store.byThread(job.thread);
      if (!target || target.key !== job.threadKey || target.cwd !== job.cwd || target.channel !== job.channel || !this.bridge.enabled(target)) {
        throw new Error('Original Slack session changed or is disabled');
      }
    }
  }
  private queueFollowup(job: Job, run: Run): void {
    this.valid(job);
    const binding = this.bridge.store.byThread(job.thread!)!;
    this.bridge.store.ingest({ ...binding, id: `schedule-followup:${run.id}`, user: job.user, unsupported: false,
      text: `[Scheduled in-thread follow-up: ${job.id}]\n`
        + (job.condition ? 'The configured executable condition exited 0. Re-read current external state before acting; this observation does not expand authorization.\n' : '')
        + 'Continue this existing conversation using the saved operator instruction below. Do not create another schedule.\n\n' + this.taskPrompt(job) });
    this.db.update({ ...run, key: binding.key, status: 'running', finished: null, deliveryState: 'queued', output: 'Follow-up queued in the existing session.' });
    this.bridge.wake();
  }
  private async conditionPasses(job: Job, scheduled: boolean): Promise<boolean> {
    if (!job.condition) return true;
    const fail = (error: string, terminal = false, checked = false, code: number | null = null) => {
      const current = this.db.get(job.id);
      if (!current || current.revision !== job.revision) return;
      const disable = terminal || current.disableOnFailure !== false;
      let nextAt = current.nextAt;
      if (!disable && scheduled) {
        nextAt = current.cron ? nextOccurrence(current.cron, current.timezone, this.now())
          : this.now() + current.condition!.pollSeconds * 1000;
      }
      this.db.save({ ...current, enabled: !disable, nextAt: disable ? null : nextAt,
        conditionLastChecked: checked ? this.now() : current.conditionLastChecked,
        conditionLastExit: checked ? code : current.conditionLastExit, conditionError: error });
    };
    if (job.condition.expiresAt <= this.now()) { fail('Condition expired', true); return false; }
    const controller = new AbortController(); this.checks.set(job.id, controller);
    let result;
    try { result = await this.check(job.condition, job.cwd, controller.signal); }
    catch { result = { code: null, error: 'Could not execute condition' }; }
    finally { this.checks.delete(job.id); }
    const current = this.db.get(job.id);
    if (this.stopped || controller.signal.aborted || !current || current.revision !== job.revision) return false;
    // A binding can be revoked while the executable is running.
    try { this.valid(current); } catch { fail('Original schedule destination is no longer authorized', true, true, result.code); return false; }
    Object.assign(job, current, { conditionLastChecked: this.now(), conditionLastExit: result.code, conditionError: null });
    if (job.condition.expiresAt <= this.now()) { fail('Condition expired', true, true, result.code); return false; }
    if (result.error || (result.code !== 0 && result.code !== 1)) {
      fail(result.error ?? 'Condition failed (expected exit 0 for ready or 1 for pending)', false, true, result.code);
      console.error(`Scheduled condition failed for ${job.id}; inspect schedule get/list.`);
      return false;
    }
    if (result.code === 1 && scheduled) {
      job.nextAt = job.cron ? nextOccurrence(job.cron, job.timezone, this.now()) : this.now() + job.condition.pollSeconds * 1000;
    }
    this.db.save(job);
    return result.code === 0;
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
    if (this.launches.has(job.id)) throw new Error('This schedule already has a condition check or launch in progress');
    this.launches.add(job.id);
    try { return await this.launchOnce(job, scheduled); }
    finally { this.launches.delete(job.id); }
  }
  private async launchOnce(job: Job, scheduled: boolean): Promise<Run> {
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
    if (!await this.conditionPasses(job, scheduled)) return { ...run, status: 'skipped', finished: this.now(), error: 'Condition did not trigger; inspect schedule condition state' };
    // Check the live definition after the async predicate, before claiming any work.
    if (this.stopped || this.db.get(job.id)?.revision !== job.revision) return { ...run, status: 'skipped', finished: this.now(), error: 'Schedule changed or stopped' };
    if (this.busy(job)) return { ...run, status: 'skipped', finished: this.now(), error: 'Project became busy during the condition check; firing deferred' };
    if (scheduled) {
      job.nextAt = job.cron ? nextOccurrence(job.cron, job.timezone, this.now()) : null;
      if (!job.cron) job.enabled = false;
    }
    if (job.condition && job.repeat !== true) { job.enabled = false; job.nextAt = null; }
    if (job.thread) run.deliveryState = 'preparing-followup';
    // Advance the schedule and journal intent together, before either external side effect.
    this.db.claim(job, run);
    if (job.thread) {
      try { this.queueFollowup(job, run); }
      catch {
        this.db.update({ ...run, status: 'failed', finished: this.now(), error: 'Could not queue follow-up in the original session' });
      }
      return this.db.run(run.id)!;
    }
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
      const prompt = this.taskPrompt(job);
      const instruction = `${prompt}\n\n[Scheduled execution: ${job.id}]\nThis is one occurrence of an existing task; perform the work now. Do not create another schedule. When no action was taken, nothing changed, and no error, blocker, or question needs attention, return exactly [SILENT] as your final answer. Never use [SILENT] after an action or to hide a failure or request for judgment. Preserve the user's stated authorization and project instructions. Finish with a concise summary of findings, changes, verification, commits/deployment if requested, and any unresolved question.${job.channel ? ' Your output and questions are delivered to the linked Slack thread, where the user can reply.' : ' There is no linked Slack channel. If user judgment is required, finish with the question so it is saved in the local run history.'}`;
      await this.bridge.agent.input(run.thread, job.cwd, instruction);
      // Completion may arrive before the turn/start acknowledgement; never overwrite it here.
    } catch (error) {
      const saved = this.db.run(run.id)!;
      if (saved.status === 'starting' || saved.status === 'running') {
        const promptMayHaveRun = Boolean(saved.thread);
        this.db.update({ ...saved, status: error instanceof AgentError || !promptMayHaveRun ? 'failed' : 'uncertain', finished: this.now(),
          error: promptMayHaveRun
            ? 'Could not confirm scheduled task delivery. Inspect the session and Slack thread before resolving; it was not retried.'
            : 'Agent session creation did not complete, so no task prompt was dispatched. Future occurrences remain unblocked.' });
        await this.ensureRoot(saved);
        const delivered = this.db.run(run.id)!;
        if (delivered.key) this.bridge.say(delivered.key, 'Could not confirm this scheduled run. It was not repeated. Use !status to inspect the saved session.');
      }
    }
    await this.bridge.flush();
    return this.db.run(run.id)!;
  }
  private async notification(method: string, params: Record<string, unknown>): Promise<boolean> {
    const thread = String(params.threadId ?? '');
    const followup = this.followupRun(thread);
    if (followup) {
      if (method === 'turn/completed') {
        const turn = record(params.turn);
        const status = turn.status;
        const error = status === 'failed' ? turnError(turn).detail : null;
        this.db.update({ ...followup,
          status: followup.status === 'uncertain' ? 'uncertain'
            : status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed',
          finished: this.now(), error });
      }
      return false;
    }
    let run = this.db.byThread(thread);
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
      const turn = record(params.turn);
      const status = turn.status;
      if (status === 'failed') {
        const error = turnError(turn);
        run = this.db.update({ ...run, error: error.detail });
        console.error(`Scheduled task ${run.jobId} failed (run ${run.id}, session ${run.thread}): ${error.summary}`);
      }
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
        if (raw.action === 'remove') { this.checks.get(job.id)?.abort(); this.db.remove(job.id); return { removed: job.id, runningWorkStopped: false }; }
        if (raw.action === 'pause') { this.checks.get(job.id)?.abort(); return this.db.save({ ...job, enabled: false }); }
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
