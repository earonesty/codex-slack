import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Rpc } from '../src/rpc.ts';
import { Interactions } from '../src/interactions.ts';

class FakeRpc extends Rpc {
  responses: { id: string | number; result: unknown }[] = [];
  rejections: string[] = [];
  constructor() { super('unused'); }
  override respond(id: string | number, result: unknown) { this.responses.push({ id, result }); }
  override reject(_id: string | number, message: string) { this.rejections.push(message); }
}
function setup() {
  const store = new Store(':memory:'); const rpc = new FakeRpc();
  store.ingest({ id: '1', user: 'U123', key: 'T123:C123:1.1', channel: 'C123', root: '1.1', cwd: '/project', thread: null, text: '', unsupported: false });
  store.bind('T123:C123:1.1', 'thread-1');
  const ui = new Interactions(rpc, store);
  return { store, rpc, ui };
}
function token(store: Store): string {
  const payload = JSON.parse(store.deliveries().at(-1)!.payload);
  return payload.blocks.at(-1).elements[0].value;
}

test('approval uses native decisions and rejects replayed or invented actions', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', command: 'echo hello' } });
  const key = token(store);
  assert.throws(() => ui.choose(key, 'acceptForSession'), /Invalid/);
  ui.choose(key, 'accept');
  assert.deepEqual(rpc.responses, [{ id: 1, result: { decision: 'accept' } }]);
  assert.throws(() => ui.choose(key, 'accept'), /expired/);
});

test('restricted available decisions do not expose approval', t => {
  const { store, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', availableDecisions: ['decline', 'cancel'] } });
  assert.throws(() => ui.choose(token(store), 'accept'), /Invalid/);
});

test('file approvals include the proposed diff and cannot approve when the diff is missing', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch-1' } });
  assert.throws(() => ui.choose(token(store), 'accept'), /Invalid/);
  ui.observe('thread-1', 'turn-1', { id: 'patch-2', type: 'fileChange', changes: [{ path: '/project/file', diff: '+fixed' }] });
  ui.receive({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch-2' } });
  assert.match(store.deliveries().at(-1)!.payload, /\+fixed/);
  ui.choose(token(store), 'accept');
  assert.deepEqual(rpc.responses[0]?.result, { decision: 'accept' });
});

test('permissions grant only requested fields for this turn and omit null fields', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', permissions: { network: { enabled: true }, fileSystem: null } } });
  ui.choose(token(store), 'accept');
  assert.deepEqual(rpc.responses[0]?.result, { permissions: { network: { enabled: true } }, scope: 'turn' });
});

test('question form maps answers to native question IDs', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 5, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'strategy', question: 'Which strategy?', options: [{ label: 'A', description: 'First option' }] }] } });
  const key = token(store);
  assert.equal(ui.modal(key).type, 'modal');
  ui.answer(key, { q0: { answer: { value: 'A, with adjustments' } } });
  assert.deepEqual(rpc.responses[0]?.result, { answers: { strategy: { answers: ['A, with adjustments'] } } });
});

test('requests expire when resolved, completed, or disconnected', t => {
  const { store, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  const first = token(store); ui.resolved(1, 'different-thread'); assert.ok(ui.lookup(first));
  ui.resolved(1, 'thread-1'); assert.equal(ui.lookup(first), undefined);
  ui.receive({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-2' } });
  const second = token(store); ui.clear('thread-1', 'turn-1'); assert.ok(ui.lookup(second));
  ui.clear(); assert.equal(ui.lookup(second), undefined);
});

test('unsupported forms and oversized approvals never receive an automatic approval', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', mode: 'url' } });
  assert.deepEqual(rpc.responses[0]?.result, { action: 'decline', content: null });
  ui.receive({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', reason: 'a'.repeat(13000) } });
  assert.equal(rpc.rejections.length, 1);
  ui.receive({ id: 3, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'password', question: 'Secret?', isSecret: true }] } });
  assert.equal(rpc.rejections.length, 2);
});
