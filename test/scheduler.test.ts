import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Rpc } from '../src/rpc.ts';
import { Codex } from '../src/codex.ts';
import { Store } from '../src/store.ts';
import { Bridge } from '../src/bridge.ts';
import { Scheduler, nextOccurrence } from '../src/scheduler.ts';
import { ScheduleStore } from '../src/schedule-store.ts';
import { listenControl, controlRequest } from '../src/control.ts';
import { record } from '../src/config.ts';
import type { Message } from '../src/messages.ts';
import type { TestContext } from 'node:test';
import { checkCondition, type CheckCondition } from '../src/condition.ts';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await sleep(10); }
  assert.fail('Timed out');
}
function fixture(t: TestContext, postFailure = false, postDelay = 0, check?: CheckCondition) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-schedule-'));
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc);
  const store = new Store(':memory:');
  const db = new ScheduleStore(':memory:');
  const outputs: (Message & { key: string })[] = [];
  const roots: { channel: string; text: string }[] = [];
  const config = { root: dir, teamId: 'T123', allowedUserIds: ['U123'], channels: { C123: { cwd: dir } }, stateDir: dir, agent: { driver: 'codex' as const, command: 'unused' }, scheduledBrowserUse: false };
  const bridge = new Bridge(config, store, codex, async (binding, message) => { outputs.push({ key: binding.key, ...message }); });
  let time = Date.parse('2026-09-13T15:00:00Z');
  const scheduler = new Scheduler(bridge, db, async (channel, text) => {
    roots.push({ channel, text });
    if (postDelay) await sleep(postDelay);
    if (postFailure) throw new Error('Lost acknowledgement');
    return `${100 + roots.length}.1`;
  }, () => time, check);
  const job = { id: 'weekly', name: 'Weekly check', prompt: 'Check the logs', cwd: dir, cron: '0 9 * * 1', timezone: 'America/Los_Angeles' };
  t.after(async () => { scheduler.stop(); await bridge.stop(); db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, rpc, codex, store, db, outputs, roots, config, bridge, scheduler, job, setTime: (next: number) => { time = next; } };
}

test('weekly wall time follows DST and invalid schedules are rejected', () => {
  assert.equal(new Date(nextOccurrence('0 9 * * 1', 'America/Los_Angeles', Date.parse('2026-10-27T00:00:00Z'))).toISOString(), '2026-11-02T17:00:00.000Z');
  assert.equal(new Date(nextOccurrence('0 9 * * 1', 'America/Los_Angeles', Date.parse('2026-03-03T00:00:00Z'))).toISOString(), '2026-03-09T16:00:00.000Z');
  assert.throws(() => nextOccurrence('* * * * * *', 'UTC', Date.now()), /five-field/);
  assert.throws(() => nextOccurrence('0 9 * * 1', 'Invalid/Timezone', Date.now()));
  assert.throws(() => nextOccurrence('invalid', 'UTC', Date.now()));
});

test('save pins closest project channel, validates inputs, and updates idempotently', t => {
  const f = fixture(t);
  const sub = path.join(f.dir, 'project'); mkdirSync(sub);
  const saved = f.scheduler.put({ ...f.job, cwd: sub });
  assert.equal(saved.channel, 'C123'); assert.equal(saved.channelCwd, f.dir);
  assert.equal(new Date(saved.nextAt!).toISOString(), '2026-09-14T16:00:00.000Z');
  f.setTime(saved.nextAt! + 1000);
  assert.equal(f.scheduler.put({ ...f.job, cwd: sub }).nextAt, saved.nextAt);
  assert.equal(f.db.list().length, 1);
  assert.throws(() => f.scheduler.put({ ...f.job, cwd: '/tmp' }), /inside/);
  assert.throws(() => f.scheduler.put({ ...f.job, at: '2026-10-01T00:00:00Z' }), /exactly one/);
  assert.throws(() => f.scheduler.put({ ...f.job, cron: null, at: '2026-10-01T00:00:00' }), /offset/);
  assert.throws(() => f.scheduler.put({ ...f.job, user: 'U999' }), /authorized/);
  assert.equal(f.scheduler.put({ ...f.job, channel: null }).channel, null);
});

test('scheduled output lands in a new bound thread and Slack replies resume that session', async t => {
  const f = fixture(t);
  const job = f.scheduler.put(f.job);
  f.setTime(job.nextAt!);
  await f.scheduler.tick();
  await until(() => f.db.history()[0]?.status === 'completed');
  const run = f.db.history()[0]!;
  const started = record(record(await f.rpc.request('thread/read', { threadId: run.thread })).thread);
  assert.deepEqual(started.startParams, { cwd: f.dir });
  const startedTurns = JSON.stringify(started.turns);
  assert.match(startedTurns, /\[Unattended browser policy\]/);
  assert.match(startedTurns, /interactive or headless browser sessions driven through repository-owned CDP/);
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0]?.channel, 'C123');
  assert.ok(run.output.includes('Reply: Check the logs'));
  assert.equal(f.store.get(run.key!)?.thread, run.thread);
  assert.equal(f.outputs.filter(output => output.text.includes('Reply: Check the logs')).length, 1);
  assert.equal(f.rpc.recycle(), true);
  f.bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '102.1', thread_ts: '101.1', text: 'Investigate the timeout' });
  await until(() => f.outputs.some(output => output.text === 'Reply: Investigate the timeout'));
  assert.equal(f.store.get(run.key!)?.thread, run.thread);
  assert.equal(f.outputs.find(output => output.text === 'Reply: Investigate the timeout')?.key, run.key);
  const resumed = record(record(await f.rpc.request('thread/read', { threadId: run.thread })).thread);
  assert.deepEqual(resumed.resumeParams, { threadId: run.thread });
  await f.scheduler.tick();
  assert.equal(f.roots.length, 1);
});

test('overdue recurring work catches up once; one-shot work is consumed once', async t => {
  const f = fixture(t);
  f.scheduler.put(f.job);
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  await f.scheduler.tick();
  await until(() => f.db.history()[0]?.status === 'completed');
  await f.scheduler.tick(); assert.equal(f.roots.length, 1);
  assert.equal(new Date(f.db.get('weekly')!.nextAt!).toISOString(), '2026-10-05T16:00:00.000Z');
  const once = f.scheduler.put({ ...f.job, id: 'once', cron: null, at: '2026-10-02T00:00:00Z' });
  f.setTime(once.nextAt!); await f.scheduler.tick();
  await until(() => f.db.history('once')[0]?.status === 'completed');
  await f.scheduler.tick(); assert.equal(f.roots.length, 2);
  assert.equal(f.db.get('once')?.enabled, false);
  assert.equal(f.db.get('once')?.nextAt, null);
});

test('explicit Codex permissions persist on resume using the saved run snapshot', async t => {
  const f = fixture(t);
  const codexPermissions = { sandbox: 'read-only' as const, approvalPolicy: 'on-request' as const };
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, codexPermissions }));
  await until(() => f.db.run(run.id)?.status === 'completed');
  const started = record(record(await f.rpc.request('thread/read', { threadId: run.thread })).thread);
  assert.deepEqual(started.startParams, { cwd: f.dir, ...codexPermissions });
  f.scheduler.put(f.job); // Future occurrences inherit defaults; this run keeps its explicit settings.
  f.codex.close();
  const restored = new Codex(f.rpc);
  restored.permissionsForThread = f.codex.permissionsForThread;
  t.after(() => restored.close());
  await restored.resume(run.thread!);
  const resumed = record(record(await f.rpc.request('thread/read', { threadId: run.thread })).thread);
  assert.deepEqual(resumed.resumeParams, { threadId: run.thread, ...codexPermissions });
});

test('permission overrides reject invalid settings and unknown fields', t => {
  const f = fixture(t);
  for (const codexPermissions of [null, [], { sandbox: 'invalid' }, { sandbox: ['read-only'] }, { approvalPolicy: 'invalid' }, { approval_policy: 'never' }]) {
    assert.throws(() => f.scheduler.put({ ...f.job, codexPermissions }), /codexPermissions/);
  }
});

test('local-only tasks preserve final output and create no Slack message', async t => {
  const f = fixture(t);
  const job = f.scheduler.put({ ...f.job, channel: null });
  await f.scheduler.launch(job);
  await until(() => f.db.history()[0]?.status === 'completed');
  assert.equal(f.roots.length, 0); assert.equal(f.outputs.length, 0);
  assert.ok(f.db.history()[0]!.output.includes('Check the logs'));
  assert.ok(f.db.history()[0]!.thread);
});

test('scheduled questions reach Slack and answering continues the same run', async t => {
  const f = fixture(t);
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt: 'question' }));
  await until(() => f.outputs.some(output => output.text === 'Codex has a question.'));
  assert.equal(f.db.run(run.id)?.status, 'running');
  await assert.rejects(f.scheduler.launch(f.db.get('weekly')!), /blocking/);
  const question = f.outputs.find(output => output.text === 'Codex has a question.')!;
  const actions = record(question.blocks?.find(block => block.type === 'actions'));
  const token = String(record((actions.elements as unknown[])[0]).value);
  f.bridge.interactions.answer(token, { q0: { answer: { value: 'Checkout' } } });
  await until(() => f.db.run(run.id)?.status === 'completed');
  assert.equal(f.db.run(run.id)?.output, 'Answer received: Checkout');
  assert.ok(f.outputs.some(output => output.key === f.db.run(run.id)?.key && output.text === 'Answer received: Checkout'));
});

test('definite task rejection records failure without replaying or losing the thread', async t => {
  const f = fixture(t);
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt: 'reject' }));
  assert.equal(run.status, 'failed'); assert.ok(run.thread);
  assert.equal(f.store.get(run.key!)?.thread, run.thread);
  assert.equal(f.roots.length, 1); assert.equal(f.db.active().length, 0);
});

test('two simultaneous run requests cannot launch overlapping work', async t => {
  const f = fixture(t);
  const job = f.scheduler.put({ ...f.job, prompt: 'hold' });
  const results = await Promise.allSettled([f.scheduler.launch(job), f.scheduler.launch(job)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.roots.length, 0); assert.equal(f.db.active().length, 1);
});

test('ambiguous Slack launch before session creation fails without blocking future work', async t => {
  const f = fixture(t, true);
  const job = f.scheduler.put({ ...f.job, verbosity: 'verbose' });
  const run = await f.scheduler.launch(job);
  assert.equal(run.status, 'failed'); assert.equal(run.thread, null);
  assert.equal(f.db.active().length, 0);
  f.setTime(job.nextAt!); await f.scheduler.tick();
  assert.equal(f.roots.length, 2);
  assert.equal(f.db.history()[0]?.status, 'failed');
  assert.equal(f.db.active().length, 0);
});

test('manual active work blocks scheduled edits in the same and nested folders', async t => {
  const f = fixture(t);
  f.bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '1.1', text: 'hold' });
  await until(() => f.codex.active.size === 1);
  const sub = path.join(f.dir, 'project'); mkdirSync(sub);
  const job = f.scheduler.put({ ...f.job, cwd: sub });
  f.setTime(job.nextAt!); await f.scheduler.tick();
  assert.equal(f.db.history()[0]?.status, 'skipped'); assert.equal(f.roots.length, 0);
  const once = f.scheduler.put({ ...f.job, id: 'once', cron: null, at: '2026-09-15T00:00:00Z' });
  f.setTime(once.nextAt!); await f.scheduler.tick();
  assert.equal(f.db.get('once')?.enabled, true); assert.equal(f.db.history('once').length, 0);
  await f.codex.interrupt(f.store.get('T123:C123:1.1')!.thread!);
  await until(() => f.codex.active.size === 0);
  await f.scheduler.tick();
  await until(() => f.db.history('once')[0]?.status === 'completed');
  await f.scheduler.tick();
  assert.equal(f.db.history('once').length, 1);
  assert.equal(f.db.get('once')?.enabled, false);
  assert.equal(f.db.get('once')?.nextAt, null);
});

test('scheduled work in sibling directories runs concurrently without a shared-prefix false conflict', async t => {
  const f = fixture(t);
  const first = path.join(f.dir, 'project');
  const second = path.join(f.dir, 'project-other');
  mkdirSync(first); mkdirSync(second);
  const jobs = [first, second].map((cwd, i) => f.scheduler.put({ ...f.job, id: `sibling-${i}`, cwd, prompt: 'hold' }));
  const runs = await Promise.all(jobs.map(job => f.scheduler.launch(job)));
  assert.equal(f.db.active().length, 2);
  assert.equal(f.codex.active.size, 2);
  assert.notEqual(runs[0]!.thread, runs[1]!.thread);
  for (const run of runs) await f.codex.interrupt(run.thread!);
  await until(() => runs.every(run => f.db.run(run.id)?.status === 'interrupted'));
  assert.equal(f.roots.length, 2);
  assert.notEqual(f.db.run(runs[0]!.id)!.key, f.db.run(runs[1]!.id)!.key);
});

test('changed routing disables scheduled work instead of sending it to a different project', async t => {
  const f = fixture(t);
  const job = f.scheduler.put(f.job);
  const other = path.join(f.dir, 'other'); mkdirSync(other);
  f.config.channels.C123 = { cwd: other };
  f.setTime(job.nextAt!); await f.scheduler.tick();
  assert.equal(f.db.get(job.id)?.enabled, false);
  assert.match(f.db.history()[0]!.error!, /binding changed/);
  assert.equal(f.roots.length, 0);
});

test('pause, resume and remove preserve history and do not run tasks', async t => {
  const f = fixture(t); const job = f.scheduler.put(f.job);
  await f.scheduler.command({ action: 'pause', id: job.id });
  f.setTime(job.nextAt!); await f.scheduler.tick(); assert.equal(f.roots.length, 0);
  await f.scheduler.command({ action: 'resume', id: job.id });
  assert.ok(f.db.get(job.id)!.nextAt! > job.nextAt!);
  await f.scheduler.command({ action: 'remove', id: job.id });
  assert.equal(f.db.list().length, 0);
});

test('durable intent with a created session survives reopening without replay and retains final output', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'schedule-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.sqlite');
  let db = new ScheduleStore(filename);
  db.add({ id: 'run', jobId: 'job', cwd: dir, thread: 'session', key: 'T123:C123:1.1',
    status: 'running', started: 1, finished: null, output: 'Prior result', error: null });
  db.close(); db = new ScheduleStore(filename);
  assert.equal(db.recover().length, 1);
  assert.equal(db.recover().length, 0);
  assert.equal(db.run('run')?.status, 'uncertain');
  assert.equal(db.run('run')?.output, 'Prior result');
  assert.equal(db.active().length, 1); db.close();
});

test('restart before session creation releases the schedule automatically', t => {
  const f = fixture(t);
  const job = f.scheduler.put(f.job);
  f.db.add({ id: 'pre-session', jobId: job.id, cwd: job.cwd, thread: null, key: null,
    status: 'starting', started: 1, finished: null, output: '', error: null, jobSnapshot: JSON.stringify(job) });
  assert.equal(f.db.recover().length, 0);
  assert.equal(f.db.run('pre-session')?.status, 'interrupted');
  assert.match(f.db.run('pre-session')?.error ?? '', /No task prompt was dispatched/);
  assert.equal(f.db.active().length, 0);
});

test('private control socket supports the complete save/read flow and returns validation failures', async t => {
  const f = fixture(t);
  const filename = path.join(f.dir, 'control.sock');
  const server = await listenControl(filename, value => f.scheduler.command(value));
  t.after(() => server.close());
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  await controlRequest(filename, { action: 'put', job: f.job });
  const result = await controlRequest(filename, { action: 'get', id: f.job.id });
  assert.equal((result as { channel: string }).channel, 'C123');
  await assert.rejects(controlRequest(filename, { action: 'put', job: { ...f.job, cron: 'wrong' } }), /five-field/);
  assert.equal(f.db.list().length, 1);
});


test('quiet is the default, including old saved definitions, and verbosity is validated', t => {
  const f = fixture(t);
  const job = f.scheduler.put(f.job);
  assert.equal(job.verbosity, 'quiet');
  delete job.verbosity; f.db.save(job);
  assert.equal(f.db.get(job.id)?.verbosity, 'quiet');
  assert.equal(f.db.list()[0]?.verbosity, 'quiet');
  assert.throws(() => f.scheduler.put({ ...f.job, verbosity: 'loud' }), /verbosity/);
  assert.throws(() => f.scheduler.put({ ...f.job, scheduledBrowserUse: 'yes' }), /scheduledBrowserUse/);
});

for (const prompt of ['silent', 'silent-progress', 'empty']) {
  test(`quiet ${prompt} run leaves history but no Slack root or reply`, async t => {
    const f = fixture(t);
    const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt }));
    await until(() => f.db.run(run.id)?.status === 'completed');
    assert.equal(f.roots.length, 0); assert.equal(f.outputs.length, 0);
    assert.equal(f.db.run(run.id)?.key, null);
    assert.ok(f.db.run(run.id)?.thread);
    if (prompt !== 'empty') assert.equal(f.db.run(run.id)?.output.trim(), '[SILENT]');
  });
}

test('verbose mode posts starts, progress, and no-op results', async t => {
  const f = fixture(t);
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt: 'silent-progress', verbosity: 'verbose' }));
  await until(() => f.db.run(run.id)?.status === 'completed');
  assert.equal(f.roots.length, 1);
  assert.ok(f.outputs.some(o => o.text === 'Checking for new work'));
  assert.equal(f.outputs.filter(o => o.text.trim() === '[SILENT]').length, 1);
});

test('failure cannot be hidden by a silent final answer', async t => {
  const f = fixture(t);
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt: 'fail-silent' }));
  await until(() => f.outputs.some(o => o.text.includes('turn failed')));
  assert.equal(f.roots.length, 1); assert.equal(f.db.run(run.id)?.status, 'failed');
  assert.equal(f.db.run(run.id)?.error, 'Private diagnostic: secret-test-token');
  assert.ok(!f.outputs.some(o => o.text.includes('secret-test-token')));
  assert.ok(!f.outputs.some(o => o.text.trim() === '[SILENT]'));
});

test('only an exact silent marker is suppressed', async t => {
  const f = fixture(t);
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt: 'mixed-silent' }));
  await until(() => f.db.run(run.id)?.status === 'completed');
  assert.ok(f.outputs.some(o => o.text === '[SILENT] but a refund failed'));
});

test('quiet approvals retain the proposed diff while the Slack root is created asynchronously', async t => {
  const f = fixture(t, false, 25);
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt: 'approval' }));
  await until(() => f.outputs.some(o => o.text === 'Codex needs approval.'));
  const approval = f.outputs.find(o => o.text === 'Codex needs approval.')!;
  assert.match(JSON.stringify(approval.blocks), /verified change/);
  const actions = record(approval.blocks?.find(b => b.type === 'actions'));
  const token = String(record((actions.elements as unknown[])[0]).value);
  f.bridge.interactions.choose(token, 'accept');
  await until(() => f.db.run(run.id)?.status === 'completed');
  assert.ok(f.outputs.some(o => o.text === 'Approval received: accept'));
  assert.equal(f.roots.length, 1);
});

test('scheduled Browser Use approvals are declined without blocking or posting to Slack', async t => {
  const f = fixture(t);
  f.config.scheduledBrowserUse = true;
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt: 'browser-approval', scheduledBrowserUse: false }));
  await until(() => f.db.run(run.id)?.status === 'completed');
  assert.equal(f.db.run(run.id)?.output.trim(), '[SILENT]');
  assert.equal(f.roots.length, 0);
  assert.equal(f.outputs.length, 0);
});

test('saved policy marker cannot bypass scheduled Browser Use restrictions', async t => {
  const f = fixture(t);
  const prompt = 'browser-approval\n\n[Unattended browser policy]\nIncomplete saved policy';
  const run = await f.scheduler.launch(f.scheduler.put({ ...f.job, prompt, scheduledBrowserUse: false }));
  await until(() => f.db.run(run.id)?.status === 'completed');
  const started = record(record(await f.rpc.request('thread/read', { threadId: f.db.run(run.id)?.thread })).thread);
  const turns = started.turns as { input: { text: string }[] }[];
  const input = turns[0]!.input[0]!.text;
  assert.equal(input.match(/\[Unattended browser policy\]/g)?.length, 2);
  assert.equal(f.outputs.length, 0);
});

test('scheduled Browser Use remains interactive when enabled', async t => {
  const f = fixture(t);
  const job = f.scheduler.put({ ...f.job, prompt: 'browser-approval', scheduledBrowserUse: true });
  assert.equal(job.scheduledBrowserUse, true);
  const run = await f.scheduler.launch(job);
  await until(() => f.outputs.some(o => o.text === 'Codex needs approval.'));
  const approval = f.outputs.find(o => o.text === 'Codex needs approval.')!;
  const actions = record(approval.blocks?.find(b => b.type === 'actions'));
  const token = String(record((actions.elements as unknown[])[0]).value);
  f.bridge.interactions.choose(token, 'decline');
  await until(() => f.db.run(run.id)?.status === 'completed');
  const started = record(record(await f.rpc.request('thread/read', { threadId: f.db.run(run.id)?.thread })).thread);
  assert.doesNotMatch(JSON.stringify(started.turns), /\[Unattended browser policy\]/);
  assert.equal(f.roots.length, 1);
});

test('quiet delivery failure retains results and is not retried on completion or restart', async t => {
  const f = fixture(t, true);
  const run = await f.scheduler.launch(f.scheduler.put(f.job));
  await until(() => f.db.run(run.id)?.finished !== null);
  assert.equal(f.db.run(run.id)?.status, 'uncertain');
  assert.ok(f.db.run(run.id)?.output.includes('Check the logs'));
  assert.ok(f.db.run(run.id)?.thread);
  assert.equal(f.roots.length, 1);
  f.scheduler.start(); await sleep(30);
  assert.equal(f.roots.length, 1);
  await assert.rejects(f.scheduler.launch(f.db.get('weekly')!), /blocking/);
});

test('removing a running task retains its pinned destination and quiet policy', async t => {
  const f = fixture(t);
  const job = f.scheduler.put({ ...f.job, prompt: 'hold' });
  const run = await f.scheduler.launch(job);
  f.db.remove(job.id);
  await f.codex.interrupt(run.thread!);
  await until(() => f.outputs.some(o => o.text === 'Codex turn interrupted.'));
  assert.equal(f.roots.length, 1);
  assert.equal(f.db.run(run.id)?.status, 'interrupted');
});

test('restart exposes a previously invisible unfinished quiet run without replaying work', async t => {
  const f = fixture(t);
  const job = f.scheduler.put(f.job);
  f.db.add({ id: 'interrupted', jobId: job.id, cwd: job.cwd, thread: 'old-thread', key: null,
    status: 'running', started: 1, finished: null, output: '', error: null, jobSnapshot: JSON.stringify(job) });
  f.scheduler.start();
  await until(() => f.outputs.some(o => o.text.includes('bridge stopped')));
  assert.equal(f.roots.length, 1);
  assert.equal(f.db.run('interrupted')?.status, 'uncertain');
});

function seedSession(f: ReturnType<typeof fixture>) {
  const binding = { key: 'T123:C123:1.1', channel: 'C123', root: '1.1', cwd: f.dir, thread: 'saved-session' };
  f.store.ingest({ ...binding, id: 'original', user: 'U123', text: 'Watch this condition', unsupported: false });
  f.store.bind(binding.key, binding.thread); f.store.mark('original', 'done');
  return binding;
}
const predicate = { executable: process.execPath, args: ['-e', 'process.exit(1)'] };

test('conditional polls stay silent and fire once into the existing session when exit becomes zero', async t => {
  let code = 1, checks = 0;
  const f = fixture(t, false, 0, async () => { checks++; return { code }; });
  const binding = seedSession(f);
  const job = f.scheduler.put({ ...f.job, cron: '*/15 * * * *', thread: 'current', condition: predicate }, binding.thread);
  assert.equal(job.threadKey, binding.key); assert.equal(job.repeat, false);
  for (let i = 0; i < 3; i++) {
    f.setTime(f.db.get(job.id)!.nextAt!); await f.scheduler.tick();
    assert.equal(f.db.history().length, 0); assert.equal(f.roots.length, 0); assert.equal(f.outputs.length, 0);
    assert.equal(f.store.pending().length, 0);
  }
  code = 0; f.setTime(f.db.get(job.id)!.nextAt!); await f.scheduler.tick();
  await until(() => f.outputs.some(o => o.text.includes('Scheduled in-thread follow-up')));
  assert.equal(checks, 4); assert.equal(f.roots.length, 0);
  assert.ok(f.outputs.every(o => o.key === binding.key));
  assert.equal(f.store.get(binding.key)?.thread, binding.thread);
  assert.equal(f.db.get(job.id)?.enabled, false); assert.equal(f.db.get(job.id)?.nextAt, null);
  assert.equal(f.db.history()[0]?.deliveryState, 'queued');
  f.scheduler.put({ ...f.job, cron: '*/15 * * * *', thread: binding.thread, condition: predicate });
  await f.scheduler.tick(); assert.equal(checks, 4); assert.equal(f.db.history().length, 1);
});

test('condition without thread uses the normal fresh-session branch, with a one-time latch', async t => {
  const f = fixture(t, false, 0, async () => ({ code: 0 }));
  const job = f.scheduler.put({ ...f.job, condition: predicate });
  f.setTime(job.nextAt!); await f.scheduler.tick();
  await until(() => f.db.history()[0]?.status === 'completed');
  assert.equal(f.roots.length, 1); assert.ok(f.db.history()[0]?.thread);
  assert.equal(f.db.get(job.id)?.enabled, false);
});

test('one-shot at keeps waiting on exit one and repeat true explicitly allows later cron firings', async t => {
  let code = 1;
  const f = fixture(t, false, 0, async () => ({ code }));
  const binding = seedSession(f);
  const once = f.scheduler.put({ ...f.job, thread: binding.thread, cron: null, at: '2026-09-14T00:00:00Z', condition: { ...predicate, pollSeconds: 60 } });
  f.setTime(once.nextAt!); await f.scheduler.tick();
  assert.equal(f.db.get(once.id)?.nextAt, once.nextAt! + 60000);
  assert.equal(f.db.get(once.id)?.enabled, true); assert.equal(f.db.history().length, 0);
  await f.scheduler.command({ action: 'remove', id: once.id });
  code = 0;
  const repeating = f.scheduler.put({ ...f.job, cron: '*/15 * * * *', thread: binding.thread, condition: predicate, repeat: true });
  f.setTime(repeating.nextAt!); await f.scheduler.tick();
  await until(() => f.outputs.length > 0);
  await until(() => f.codex.active.size === 0);
  f.setTime(f.db.get(repeating.id)!.nextAt!); await f.scheduler.tick();
  assert.equal(f.db.history().length, 2); assert.equal(f.db.get(repeating.id)?.enabled, true);
  assert.equal(f.roots.length, 0);
});

test('ordinary schedule can target an existing conversation without a condition', async t => {
  const f = fixture(t);
  const binding = seedSession(f);
  const job = f.scheduler.put({ ...f.job, thread: binding.thread });
  f.setTime(job.nextAt!); await f.scheduler.tick();
  await until(() => f.outputs.length > 0);
  assert.equal(f.roots.length, 0); assert.ok(f.outputs.every(o => o.key === binding.key));
  assert.equal(f.db.get(job.id)?.enabled, true);
});

test('in-thread scheduled Browser Use is guarded only for the scheduled turn', async t => {
  const f = fixture(t);
  const binding = seedSession(f);
  const job = f.scheduler.put({ ...f.job, thread: binding.thread, prompt: 'browser-approval', scheduledBrowserUse: false });
  f.setTime(job.nextAt!); await f.scheduler.tick();
  await until(() => f.db.history()[0]?.status === 'completed');
  assert.equal(f.outputs.some(output => output.text === 'Codex needs approval.'), false);
  const started = record(record(await f.rpc.request('thread/read', { threadId: binding.thread })).thread);
  assert.match(JSON.stringify(started.turns), /\[Unattended browser policy\]/);

  f.bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '2.1', thread_ts: binding.root, text: 'browser-approval' });
  await until(() => f.outputs.some(output => output.text === 'Codex needs approval.'));
  const approval = f.outputs.find(output => output.text === 'Codex needs approval.')!;
  const actions = record(approval.blocks?.find(block => block.type === 'actions'));
  const token = String(record((actions.elements as unknown[])[0]).value);
  f.bridge.interactions.choose(token, 'decline');
  await until(() => f.codex.active.size === 0);
});

test('in-thread scheduled Browser Use remains interactive when enabled', async t => {
  const f = fixture(t);
  const binding = seedSession(f);
  const job = f.scheduler.put({ ...f.job, thread: binding.thread, prompt: 'browser-approval', scheduledBrowserUse: true });
  f.setTime(job.nextAt!); await f.scheduler.tick();
  await until(() => f.outputs.some(output => output.text === 'Codex needs approval.'));
  assert.equal(f.db.history()[0]?.status, 'running');
  const started = record(record(await f.rpc.request('thread/read', { threadId: binding.thread })).thread);
  assert.doesNotMatch(JSON.stringify(started.turns), /\[Unattended browser policy\]/);
  const approval = f.outputs.find(output => output.text === 'Codex needs approval.')!;
  const actions = record(approval.blocks?.find(block => block.type === 'actions'));
  const token = String(record((actions.elements as unknown[])[0]).value);
  f.bridge.interactions.choose(token, 'decline');
  await until(() => f.db.history()[0]?.status === 'completed');
});

test('condition failures and expiration disable the task without agent work or new Slack threads', async t => {
  for (const result of [{ code: 2 }, { code: null, error: 'Condition timed out' }]) {
    const f = fixture(t, false, 0, async () => result);
    const job = f.scheduler.put({ ...f.job, condition: predicate });
    f.setTime(job.nextAt!); await f.scheduler.tick();
    assert.equal(f.db.get(job.id)?.enabled, false); assert.ok(f.db.get(job.id)?.conditionError);
    assert.equal(f.roots.length, 0); assert.equal(f.db.history().length, 0);
  }
  const f = fixture(t, false, 0, async () => { assert.fail('Expired predicate must not run'); });
  const job = f.scheduler.put({ ...f.job, condition: { ...predicate, expiresAt: '2026-09-13T16:00:00Z' } });
  f.setTime(job.nextAt!); await f.scheduler.tick();
  assert.equal(f.db.get(job.id)?.conditionError, 'Condition expired'); assert.equal(f.db.get(job.id)?.enabled, false);
});

test('pause/remove/replace/shutdown during a predicate cancels a would-be successful firing', async t => {
  for (const action of ['pause', 'remove', 'replace', 'stop']) {
    let resolve!: (value: { code: number }) => void;
    const f = fixture(t, false, 0, async () => new Promise(r => { resolve = r; }));
    const binding = seedSession(f);
    const job = f.scheduler.put({ ...f.job, thread: binding.thread, condition: predicate });
    f.setTime(job.nextAt!);
    const tick = f.scheduler.tick();
    if (action === 'stop') f.scheduler.stop();
    else if (action === 'replace') f.scheduler.put({ ...job, prompt: 'Different follow-up' });
    else await f.scheduler.command({ action, id: job.id });
    resolve({ code: 0 }); await tick;
    assert.equal(f.store.pending().length, 0); assert.equal(f.db.history().length, 0); assert.equal(f.roots.length, 0);
  }
});

test('follow-up crash recovery deduplicates an input even when it already completed', async t => {
  const f = fixture(t);
  const binding = seedSession(f);
  const job = f.scheduler.put({ ...f.job, thread: binding.thread, condition: predicate });
  f.db.save({ ...job, enabled: false, nextAt: null });
  const run = { id: 'recover-follow-up', jobId: job.id, cwd: job.cwd, thread: null, key: null,
    status: 'starting' as const, started: 1, finished: null, output: '', error: null,
    jobSnapshot: JSON.stringify(job), deliveryState: 'preparing-followup' };
  f.db.add(run); f.bridge.wake = () => {};
  f.scheduler.start(); await until(() => f.db.run(run.id)?.deliveryState === 'queued');
  assert.equal(f.store.pending().length, 1); assert.equal(f.store.pending()[0]?.key, binding.key);
  f.store.mark(`schedule-followup:${run.id}`, 'done');
  f.db.update(run);
  f.scheduler.start();
  await until(() => f.db.run(run.id)?.status === 'uncertain');
  assert.equal(f.store.pending().length, 0); assert.equal(f.roots.length, 0);
});

test('condition argv bounds and original-thread ownership are validated at save', t => {
  const f = fixture(t); const binding = seedSession(f);
  for (const condition of [{ executable: 'node' }, { ...predicate, args: 'shell words' }, { ...predicate, timeoutSeconds: 0 },
    { ...predicate, pollSeconds: 1 }, { ...predicate, expiresAt: 'invalid' }]) {
    assert.throws(() => f.scheduler.put({ ...f.job, condition }));
  }
  assert.throws(() => f.scheduler.put({ ...f.job, thread: 'current' }), /thread/);
  assert.throws(() => f.scheduler.put({ ...f.job, thread: 'unknown' }), /thread/);
  assert.throws(() => f.scheduler.put({ ...f.job, thread: binding.thread, channel: null }), /thread/);
  assert.throws(() => f.scheduler.put({ ...f.job, condition: predicate, repeat: 'yes' }), /repeat/);
  const byTimestamp = f.scheduler.put({ ...f.job, thread: binding.root });
  assert.equal(byTimestamp.thread, binding.thread); assert.equal(byTimestamp.threadKey, binding.key);
});

test('active work or revoked authorization appearing during a condition prevents its follow-up', async t => {
  for (const state of ['busy', 'revoked']) {
    const f = fixture(t, false, 0, async () => {
      if (state === 'busy') f.codex.active.set('saved-session', 'interactive-turn');
      else f.config.allowedUserIds.length = 0;
      return { code: 0 };
    });
    const binding = seedSession(f);
    const job = f.scheduler.put({ ...f.job, thread: binding.thread, condition: predicate });
    f.setTime(job.nextAt!); await f.scheduler.tick();
    assert.equal(f.store.pending().length, 0); assert.equal(f.roots.length, 0);
    assert.equal(f.db.history().length, 0);
    if (state === 'revoked') assert.equal(f.db.get(job.id)?.enabled, false);
    else { assert.equal(f.db.get(job.id)?.enabled, true); f.codex.active.clear(); }
  }
});

test('real predicates support pending, ready, missing executable, timeout and cancellation', async () => {
  const condition = { ...predicate, timeoutSeconds: 1, pollSeconds: 15, expiresAt: Date.now() + 60000 };
  assert.deepEqual(await checkCondition(condition, tmpdir(), new AbortController().signal), { code: 1 });
  assert.deepEqual(await checkCondition({ ...condition, args: ['-e', 'process.exit(0)'] }, tmpdir(), new AbortController().signal), { code: 0 });
  const missing = await checkCondition({ ...condition, executable: '/not-a-real-executable' }, tmpdir(), new AbortController().signal);
  assert.equal(missing.error, 'Could not execute condition');
  const timeout = await checkCondition({ ...condition, args: ['-e', 'setInterval(()=>{},1000)'] }, tmpdir(), new AbortController().signal);
  assert.equal(timeout.error, 'Condition timed out');
  const controller = new AbortController();
  const check = checkCondition({ ...condition, args: ['-e', 'setInterval(()=>{},1000)'] }, tmpdir(), controller.signal);
  controller.abort(); assert.equal((await check).error, 'Condition cancelled');
});
