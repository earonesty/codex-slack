import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Codex } from '../src/codex.ts';
import { Rpc } from '../src/rpc.ts';
import { record } from '../src/config.ts';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));

test('RPC reassembles JSON and multibyte Unicode across stdout chunks', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  t.after(() => rpc.close());
  await rpc.start();
  assert.equal(await rpc.request('test/fragmented', {}), '🦊 fragmented reply');
});

for (const [method, error] of [
  ['test/invalid-json', /Invalid JSON/],
  ['test/exit', /disconnected/],
] as const) {
  test(`${method} rejects every pending request and permits a fresh connection`, async t => {
    const rpc = new Rpc(process.execPath, [fake]);
    t.after(() => rpc.close());
    await rpc.start();
    const pending = assert.rejects(rpc.request('test/hang', {}), error);
    const fault = assert.rejects(rpc.request(method, {}), error);
    await Promise.all([pending, fault]);
    await assert.rejects(rpc.request('test/ask', {}), /not connected/);
    await rpc.start();
    assert.equal(await rpc.request('test/fragmented', {}), '🦊 fragmented reply');
  });
}

test('closing RPC rejects outstanding work instead of leaving it waiting for a timeout', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  t.after(() => rpc.close());
  await rpc.start();
  const pending = assert.rejects(rpc.request('test/hang', {}), /Bridge stopped/);
  rpc.close();
  await pending;
  rpc.close();
});

test('idle RPC recycling disconnects cleanly and permits a fresh app-server', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  t.after(() => rpc.close());
  await rpc.start();
  assert.equal(rpc.recycle(), true);
  await assert.rejects(rpc.request('test/fragmented', {}), /not connected/);
  await rpc.start();
  assert.equal(await rpc.request('test/fragmented', {}), '🦊 fragmented reply');

  const pending = assert.rejects(rpc.request('test/hang', {}), /Bridge stopped/);
  assert.equal(rpc.recycle(), false);
  rpc.close();
  await pending;
});

test('Codex recycles after the final turn and resumes through a fresh app-server', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc, 10);
  t.after(() => codex.close());
  const thread = await codex.create('/tmp');
  await codex.input(thread, '/tmp', 'first');
  await sleep(30);
  await assert.rejects(rpc.request('test/fragmented', {}), /not connected/);
  await codex.input(thread, '/tmp', 'second');
  for (let i = 0; i < 100 && codex.active.size; i++) await sleep(5);
  assert.equal(codex.active.size, 0);
});

test('scheduled permissions do not leak into a human follow-up after idle recycling', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc, 10);
  t.after(() => codex.close());
  const scheduled = { unattended: true, sandbox: 'danger-full-access' as const, approvalPolicy: 'never' as const };
  const thread = await codex.create('/tmp', scheduled);
  await codex.input(thread, '/tmp', 'scheduled', [], scheduled);
  const initial = record(record(await rpc.request('thread/read', { threadId: thread })).thread);
  const turn = record((initial.turns as unknown[]).at(-1));
  assert.equal(record(turn.startParams).approvalPolicy, 'never');
  assert.deepEqual(record(turn.startParams).sandboxPolicy, { type: 'dangerFullAccess' });
  await sleep(30);
  await assert.rejects(rpc.request('test/fragmented', {}), /not connected/);
  await codex.input(thread, '/tmp', 'human');
  const resumed = record(record(await rpc.request('thread/read', { threadId: thread })).thread);
  assert.deepEqual(resumed.resumeParams, { threadId: thread, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  const followup = record(record((resumed.turns as unknown[]).at(-1)).startParams);
  assert.equal(followup.approvalPolicy, 'on-request');
  assert.equal(record(followup.sandboxPolicy).type, 'workspaceWrite');
});

test('human follow-up resets permissions without recycling and respects project configuration', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc);
  t.after(() => codex.close());
  const scheduled = { unattended: true, sandbox: 'danger-full-access' as const, approvalPolicy: 'never' as const };
  const thread = await codex.create('/tmp', scheduled);
  await codex.input(thread, '/tmp', 'scheduled', [], scheduled);
  await rpc.request('test/config', { approval_policy: 'untrusted', approvals_reviewer: 'auto_review',
    sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: true, writable_roots: ['/tmp/extra'] } });
  await codex.input(thread, '/tmp', 'human');
  const data = record(record(await rpc.request('thread/read', { threadId: thread })).thread);
  const params = record(record((data.turns as unknown[]).at(-1)).startParams);
  assert.equal(params.approvalPolicy, 'untrusted');
  assert.equal(params.approvalsReviewer, 'auto_review');
  assert.deepEqual(params.sandboxPolicy, { type: 'workspaceWrite', networkAccess: true,
    writableRoots: ['/tmp/extra'], excludeTmpdirEnvVar: false, excludeSlashTmp: false });
});

test('scheduled dispatch explicitly restores its selected permissions in a fresh app-server', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc);
  t.after(() => codex.close());
  const options = { unattended: true, sandbox: 'danger-full-access' as const, approvalPolicy: 'never' as const };
  const thread = await codex.create('/tmp', options);
  assert.equal(rpc.recycle(), true);
  await codex.input(thread, '/tmp', 'scheduled', [], options);
  const data = record(record(await rpc.request('thread/read', { threadId: thread })).thread);
  assert.deepEqual(data.resumeParams, { threadId: thread, sandbox: 'danger-full-access', approvalPolicy: 'never' });
});
