import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/store.ts';
import { Bridge } from '../src/bridge.ts';
import { Codex } from '../src/codex.ts';
import { Rpc } from '../src/rpc.ts';
import { recoverRestart } from '../src/restart.ts';

const binding = { key: 'T123:C123:1.1', channel: 'C123', root: '1.1', cwd: tmpdir(), thread: 'saved-session' };
const config = { root: tmpdir(), teamId: 'T123', allowedUserIds: ['U123'], channels: { C123: { cwd: tmpdir() } }, stateDir: '/unused', codexBin: 'unused' };
function seed(store: Store) {
  store.ingest({ ...binding, id: 'original', user: 'U123', text: 'Please restart the bridge', unsupported: false });
  store.bind(binding.key, binding.thread);
  store.mark('original', 'done');
}
function bridge(store: Store, outputs: { key: string; text: string }[] = []) {
  const rpc = new Rpc(process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  return new Bridge(config, store, new Codex(rpc), async (b, message) => { outputs.push({ key: b.key, text: message.text }); });
}

test('handoff survives process state reopening and confirms only a new invocation, exactly once', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bridge.sqlite');
  let store = new Store(file);
  seed(store);
  const restart = store.prepareRestart(binding.thread, 'old-invocation', 100);
  store.close();
  store = new Store(file);
  const b = bridge(store);
  t.after(async () => { await b.stop(); store.close(); });
  recoverRestart(b, 'old-invocation', 200);
  recoverRestart(b, '', 200);
  assert.equal(store.pending().length, 0);
  recoverRestart(b, 'new-invocation', 200);
  recoverRestart(b, 'another-invocation', 300);
  assert.equal(store.pending().length, 1);
  assert.equal(store.pending()[0]?.id, `restart:${restart.id}`);
  assert.equal(store.pending()[0]?.thread, binding.thread);
  assert.match(store.pending()[0]!.text, /Do not restart again or replay/);
  assert.equal(store.latestRestart()?.status, 'queued');
});

test('restart notice resumes the saved session and reaches its original Slack thread', async t => {
  const store = new Store(':memory:'); seed(store);
  store.prepareRestart(binding.thread, 'old');
  const outputs: { key: string; text: string }[] = [];
  const b = bridge(store, outputs);
  t.after(async () => { await b.stop(); store.close(); });
  recoverRestart(b, 'new');
  b.start();
  for (let i = 0; i < 300 && !outputs.length; i++) await sleep(10);
  assert.equal(store.get(binding.key)?.thread, binding.thread);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.key, binding.key);
  assert.match(outputs[0]!.text, /Reply: \[Bridge restart notification:/);
  recoverRestart(b, 'newer');
  assert.equal(store.pending().length, 0);
});

test('duplicate preparation, unknown sessions, and unauthorized recovery do not launch or redirect work', async t => {
  const store = new Store(':memory:'); seed(store);
  const b = bridge(store);
  t.after(async () => { await b.stop(); store.close(); });
  assert.throws(() => store.prepareRestart('unknown-session', 'old'), /existing, enabled/);
  store.prepareRestart(binding.thread, 'old');
  assert.throws(() => store.prepareRestart(binding.thread, 'old'), /already pending/);
  const revoked = new Bridge({ ...config, allowedUserIds: [] }, store, b.codex, async () => {});
  recoverRestart(revoked, 'new');
  assert.equal(store.pending().length, 0);
  assert.equal(store.latestRestart()?.status, 'failed');
});

test('interrupted notice dispatch is not replayed after another restart', async t => {
  const store = new Store(':memory:'); seed(store);
  const restart = store.prepareRestart(binding.thread, 'old', 0);
  const b = bridge(store);
  t.after(async () => { await b.stop(); store.close(); });
  recoverRestart(b, 'new', 11 * 60_000);
  assert.match(store.pending()[0]!.text, /confirmation is delayed/);
  store.mark(`restart:${restart.id}`, 'dispatching');
  store.recover();
  recoverRestart(b, 'newer');
  assert.equal(store.pending().length, 0);
  assert.equal(store.deliveries().length, 1);
});
