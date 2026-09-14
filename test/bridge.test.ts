import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Rpc, RpcError } from '../src/rpc.ts';
import { Codex } from '../src/codex.ts';
import { Store, type Incoming } from '../src/store.ts';
import { Bridge } from '../src/bridge.ts';
import { authorized, parseConfig, type Config } from '../src/config.ts';
import { chunks } from '../src/messages.ts';
import { Onboarding } from '../src/onboarding.ts';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const config: Config = { root: tmpdir(), teamId: 'T123', allowedUserIds: ['U123'], channels: { C123: { cwd: tmpdir() } }, stateDir: '/unused', codexBin: 'unused' };
const incoming = (id = 'T123:C123:1.1'): Incoming => ({ id, user: 'U123', key: 'T123:C123:1.1', channel: 'C123', root: '1.1', cwd: tmpdir(), thread: null, text: 'hello', unsupported: false });

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await sleep(10); }
  assert.fail('Timed out waiting for bridge condition');
}

test('configuration requires a workspace, explicit users, channel IDs, and existing directories', () => {
  assert.throws(() => parseConfig({}), /teamId/);
  assert.throws(() => parseConfig({ ...config, allowedUserIds: [] }), /allowedUserIds/);
  assert.throws(() => parseConfig({ ...config, channels: { '#name': { cwd: '/tmp' } } }), /Invalid channel/);
  const valid = parseConfig({ ...config, root: tmpdir(), channels: { C123: { cwd: tmpdir() } } });
  assert.equal(authorized(valid, 'T123', 'U123', 'C123'), true);
  assert.equal(authorized(valid, 'Tother', 'U123', 'C123'), false);
  assert.equal(authorized(valid, 'T123', 'Uother', 'C123'), false);
  assert.equal(authorized(valid, 'T123', 'U123', 'Cother'), false);
});

test('message chunks preserve Unicode without dropping or splitting surrogate pairs', () => {
  const original = '🦊'.repeat(6000);
  const parts = chunks(original);
  assert.equal(parts.join(''), original);
  assert.ok(parts.every(part => Array.from(part).length <= 2800));
});

test('SQLite deduplicates inbound messages and preserves original thread cwd', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(store.ingest(incoming()), true);
  assert.equal(store.ingest(incoming()), false);
  store.bind(incoming().key, 'thread-native');
  store.ingest({ ...incoming('T123:C123:2.1'), cwd: '/new-default' });
  assert.equal(store.get(incoming().key)?.cwd, tmpdir());
  assert.equal(store.get(incoming().key)?.thread, 'thread-native');
  assert.equal(store.pending().length, 2);
});

test('restart recovers pending input but never replays uncertain dispatch or Slack writes', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-slack-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.sqlite');
  let store = new Store(filename);
  store.ingest(incoming());
  store.bind(incoming().key, 'persisted-thread');
  store.mark(incoming().id, 'dispatching');
  store.ingest(incoming('T123:C123:2.1'));
  store.enqueue(incoming().key, { text: 'may have been posted' }, 'output-1');
  store.deliveryStatus('output-1', 'sending');
  store.close(); store = new Store(filename);
  store.recover();
  assert.deepEqual(store.pending().map(message => message.id), ['T123:C123:2.1']);
  assert.equal(store.get(incoming().key)?.thread, 'persisted-thread');
  assert.ok(store.deliveries().every(output => output.id !== 'output-1'));
  assert.equal(store.deliveries().length, 2);
  store.close();
});

test('RPC completes the handshake and separates server requests from outbound IDs', async t => {
  const rpc = new Rpc(process.execPath, [fake]); t.after(() => rpc.close());
  let requestSeen = false;
  rpc.on('request', request => { requestSeen = true; rpc.respond(request.id, { answers: {} }); });
  await Promise.all([rpc.start(), rpc.start()]);
  assert.equal(await rpc.request('test/ask', {}), 'outbound request still resolves');
  assert.equal(requestSeen, true);
  await assert.rejects(rpc.request('unknown', {}), RpcError);
});

test('RPC timeouts disconnect and a subsequent start reconnects', async t => {
  const rpc = new Rpc(process.execPath, [fake], 300); t.after(() => rpc.close());
  await rpc.start();
  await assert.rejects(rpc.request('test/hang', {}), /timed out/);
  await rpc.start();
  const codex = new Codex(rpc);
  assert.equal(await codex.create('/again'), 'thread-1');
});

test('RPC startup failure rejects promptly', async () => {
  const rpc = new Rpc('/definitely-missing-codex');
  await assert.rejects(rpc.start(), /ENOENT/);
  rpc.close();
});

test('top-level messages create sessions, replies reuse them, and duplicate events/results are ignored', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const store = new Store(':memory:');
  const outputs: { root: string; text: string }[] = [];
  const bridge = new Bridge(config, store, new Codex(rpc), async (binding, message) => { outputs.push({ root: binding.root, text: message.text }); });
  t.after(async () => { await bridge.stop(); store.close(); });
  const event = { user: 'U123', channel: 'C123', ts: '1.1', text: 'first' };
  assert.equal(bridge.ingest('T123', event), true);
  assert.equal(bridge.ingest('T123', event), false);
  await until(() => outputs.some(o => o.text === 'Reply: first'));
  const thread = store.get('T123:C123:1.1')?.thread;
  const started = await rpc.request('thread/read', { threadId: thread }) as { thread: { startParams: unknown } };
  assert.deepEqual(started.thread.startParams, { cwd: tmpdir() });
  bridge.ingest('T123', { ...event, ts: '2.1', thread_ts: '1.1', text: 'second' });
  bridge.ingest('T123', { ...event, ts: '3.1', text: 'separate' });
  await until(() => outputs.some(o => o.text === 'Reply: second') && outputs.some(o => o.text === 'Reply: separate'));
  assert.equal(store.get('T123:C123:1.1')?.thread, thread);
  assert.notEqual(store.get('T123:C123:3.1')?.thread, thread);
  assert.equal(outputs.filter(o => o.text === 'Reply: first').length, 1);
  assert.equal(outputs.find(o => o.text === 'Reply: second')?.root, '1.1');
});

test('follow-ups steer an active turn and !stop interrupts it', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc); const store = new Store(':memory:'); const outputs: string[] = [];
  const statuses: string[] = [];
  const bridge = new Bridge(config, store, codex, async (_, message) => { outputs.push(message.text); },
    async (_, status) => { statuses.push(status); });
  t.after(async () => { await bridge.stop(); store.close(); });
  bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '1.1', text: 'hold' });
  await until(() => codex.active.size === 1);
  await until(() => statuses.includes('is working…'));
  const beforeReply = statuses.length;
  bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '2.1', thread_ts: '1.1', text: 'change direction' });
  await until(() => outputs.includes('Steered: change direction'));
  await until(() => statuses.length > beforeReply);
  assert.equal(statuses.at(-1), 'is working…');
  bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '3.1', thread_ts: '1.1', text: '!stop' });
  await until(() => outputs.includes('Codex turn interrupted.'));
  assert.equal(codex.active.size, 0);
  await until(() => statuses.at(-1) === '');
});

test('directory transfer interrupts active work and old threads remain disabled after rebinding', async t => {
  const local = { ...config, channels: { C123: { cwd: tmpdir() } } };
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc); const store = new Store(':memory:'); const outputs: string[] = [];
  const bridge = new Bridge(local, store, codex, async (_, message) => { outputs.push(message.text); });
  t.after(async () => { await bridge.stop(); store.close(); });
  const onboarding = new Onboarding(local, store, async () => {}, channels => { void bridge.disableChannels(channels); });
  bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '1.1', text: 'hold' });
  await until(() => codex.active.size === 1);
  await onboarding.ask('T123', 'C999');
  const token = store.channelSetups('T123').find(row => row.channel === 'C999')!.token;
  const preview = onboarding.preview(token, 'T123', 'U123', tmpdir());
  onboarding.confirm(preview.private_metadata!, 'T123', 'U123');
  await until(() => codex.active.size === 0);
  assert.equal(bridge.enabled(store.get('T123:C123:1.1')!), false);
  local.channels.C123 = { cwd: tmpdir() };
  assert.equal(bridge.enabled(store.get('T123:C123:1.1')!), false);
  assert.ok(!outputs.includes('Codex turn interrupted.'));
});

test('non-operators, bots, edits, and other workspaces never enter the inbox', t => {
  const rpc = new Rpc('unused'); const store = new Store(':memory:');
  const bridge = new Bridge(config, store, new Codex(rpc), async () => {});
  t.after(() => store.close());
  const event = { user: 'U123', channel: 'C123', ts: '1.1', text: 'hello' };
  assert.equal(bridge.ingest('Tother', event), false);
  assert.equal(bridge.ingest('T123', { ...event, user: 'Uother' }), false);
  assert.equal(bridge.ingest('T123', { ...event, bot_id: 'B123' }), false);
  assert.equal(bridge.ingest('T123', { ...event, subtype: 'message_changed' }), false);
  assert.equal(store.pending().length, 0);
});

test('attachments are rejected visibly without sending a partial prompt', async t => {
  const rpc = new Rpc('unused'); const store = new Store(':memory:'); const outputs: string[] = [];
  const bridge = new Bridge(config, store, new Codex(rpc), async (_, message) => { outputs.push(message.text); });
  t.after(async () => { await bridge.stop(); store.close(); });
  bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '1.1', text: 'edit this', files: [{ id: 'F123' }] });
  await until(() => outputs.length > 0);
  assert.match(outputs[0]!, /Attachments are not supported/);
  assert.equal(store.get('T123:C123:1.1')?.thread, null);
});

test('saved sessions survive explicit Codex rejection without creating a replacement', async t => {
  const rpc = new Rpc(process.execPath, [fake]); const store = new Store(':memory:'); const outputs: string[] = [];
  const bridge = new Bridge(config, store, new Codex(rpc), async (_, message) => { outputs.push(message.text); });
  t.after(async () => { await bridge.stop(); store.close(); });
  bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '1.1', text: 'reject' });
  await until(() => outputs.some(text => text.startsWith('Codex rejected')));
  assert.equal(store.get('T123:C123:1.1')?.thread, 'thread-1');
  assert.equal(store.pending().length, 0);
});

test('ambiguous Slack failure is retained without automatic duplicate posting', async t => {
  const store = new Store(':memory:'); const rpc = new Rpc('unused'); let attempts = 0;
  store.ingest(incoming()); store.mark(incoming().id, 'done');
  store.enqueue(incoming().key, { text: 'answer' });
  const bridge = new Bridge(config, store, new Codex(rpc), async () => { attempts++; throw new Error('network lost after write'); });
  t.after(() => store.close());
  await bridge.flush(); await bridge.flush();
  assert.equal(attempts, 1);
  assert.equal(store.deliveries().length, 0);
});

test('stopping one Slack thread leaves another active and later replies reuse the stopped session', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc); const store = new Store(':memory:');
  const outputs: { root: string; text: string }[] = [];
  const bridge = new Bridge(config, store, codex, async (binding, message) => {
    outputs.push({ root: binding.root, text: message.text });
  });
  t.after(async () => { await bridge.stop(); store.close(); });
  const event = { user: 'U123', channel: 'C123' };
  bridge.ingest('T123', { ...event, ts: '1.1', text: 'hold' });
  bridge.ingest('T123', { ...event, ts: '2.1', text: 'hold' });
  await until(() => codex.active.size === 2);
  const first = store.get('T123:C123:1.1')!.thread!;
  const second = store.get('T123:C123:2.1')!.thread!;
  bridge.ingest('T123', { ...event, ts: '3.1', thread_ts: '1.1', text: '!stop' });
  await until(() => outputs.some(o => o.root === '1.1' && o.text === 'Codex turn interrupted.'));
  assert.equal(codex.active.has(first), false);
  assert.equal(codex.active.has(second), true);
  bridge.ingest('T123', { ...event, ts: '4.1', thread_ts: '1.1', text: 'continue after stop' });
  await until(() => outputs.some(o => o.root === '1.1' && o.text === 'Reply: continue after stop'));
  assert.equal(store.get('T123:C123:1.1')!.thread, first);
  assert.equal(codex.active.has(second), true);
});

test('idle stop and status commands never create a model session', async t => {
  const store = new Store(':memory:'); const outputs: string[] = [];
  const bridge = new Bridge(config, store, new Codex(new Rpc('/must-not-start')), async (_, message) => { outputs.push(message.text); });
  t.after(async () => { await bridge.stop(); store.close(); });
  bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '1.1', text: '!stop' });
  bridge.ingest('T123', { user: 'U123', channel: 'C123', ts: '2.1', thread_ts: '1.1', text: '!status' });
  await until(() => outputs.length === 2);
  assert.equal(outputs[0], 'No active turn to interrupt.');
  assert.match(outputs[1]!, /^No Codex session yet/);
  assert.equal(store.get('T123:C123:1.1')!.thread, null);
});
