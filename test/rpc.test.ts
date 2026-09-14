import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Rpc } from '../src/rpc.ts';

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
