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

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await sleep(10); }
  assert.fail('Timed out');
}
function fixture(t: TestContext, postFailure = false, postDelay = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-schedule-'));
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc);
  const store = new Store(':memory:');
  const db = new ScheduleStore(':memory:');
  const outputs: (Message & { key: string })[] = [];
  const roots: { channel: string; text: string }[] = [];
  const config = { root: dir, teamId: 'T123', allowedUserIds: ['U123'], channels: { C123: { cwd: dir } }, stateDir: dir, codexBin: 'unused' };
  const bridge = new Bridge(config, store, codex, async (binding, message) => { outputs.push({ key: binding.key, ...message }); });
  let time = Date.parse('2026-09-13T15:00:00Z');
  const scheduler = new Scheduler(bridge, db, async (channel, text) => {
    roots.push({ channel, text });
    if (postDelay) await sleep(postDelay);
    if (postFailure) throw new Error('Lost acknowledgement');
    return `${100 + roots.length}.1`;
  }, () => time);
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
  assert.deepEqual(started.startParams, { cwd: f.dir, sandbox: 'danger-full-access', approvalPolicy: 'never' });
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0]?.channel, 'C123');
  assert.ok(run.output.includes('Reply: Check the logs'));
  assert.equal(f.store.get(run.key!)?.thread, run.thread);
  assert.equal(f.outputs.filter(output => output.text.includes('Reply: Check the logs')).length, 1);
  f.bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '102.1', thread_ts: '101.1', text: 'Investigate the timeout' });
  await until(() => f.outputs.some(output => output.text === 'Reply: Investigate the timeout'));
  assert.equal(f.store.get(run.key!)?.thread, run.thread);
  assert.equal(f.outputs.find(output => output.text === 'Reply: Investigate the timeout')?.key, run.key);
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

test('ambiguous Slack launch is recorded once, blocks overlapping work, and is never replayed', async t => {
  const f = fixture(t, true);
  const job = f.scheduler.put({ ...f.job, verbosity: 'verbose' });
  const run = await f.scheduler.launch(job);
  assert.equal(run.status, 'uncertain'); assert.equal(run.thread, null);
  await assert.rejects(f.scheduler.launch(job), /blocking/);
  f.setTime(job.nextAt!); await f.scheduler.tick();
  assert.equal(f.roots.length, 1);
  assert.equal(f.db.history()[0]?.status, 'skipped');
  await assert.rejects(f.scheduler.command({ action: 'resolve', id: run.id }), /note/);
  await f.scheduler.command({ action: 'resolve', id: run.id, note: 'Verified no session was created' });
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

test('durable intent survives reopening without replay and retains final output', t => {
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
