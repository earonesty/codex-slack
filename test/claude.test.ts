import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Claude } from '../src/claude.ts';

const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await sleep(10); }
  assert.fail('Timed out waiting for Claude driver condition');
}

test('Claude driver checks auth and translates streaming results into normalized turns', async t => {
  const claude = new Claude(process.execPath, [fake]);
  t.after(() => claude.close());
  await claude.start();
  const events: { method: string; params: Record<string, unknown> }[] = [];
  claude.on('notification', (method, params) => events.push({ method, params }));
  const session = await claude.create(tmpdir());
  await claude.input(session, tmpdir(), 'hello');
  await until(() => events.some(event => event.method === 'turn/completed'));
  assert.deepEqual(events.map(event => event.method), ['turn/started', 'item/completed', 'turn/completed']);
  assert.match(await claude.status(session, tmpdir()), /Latest answer:\nClaude reply: hello/);
  assert.equal(claude.active.size, 0);

  events.length = 0;
  await claude.input(session, tmpdir(), 'again');
  await until(() => events.some(event => event.method === 'turn/completed'));
  assert.equal(String((events.find(event => event.method === 'item/completed')?.params.item as { text: string }).text), 'Claude reply: again');
});

test('Claude driver interrupts an active streamed turn', async t => {
  const claude = new Claude(process.execPath, [fake]);
  t.after(() => claude.close());
  const session = await claude.create(tmpdir());
  const completed: string[] = [];
  claude.on('notification', (method, params) => {
    if (method === 'turn/completed') completed.push(String((params.turn as { status: string }).status));
  });
  await claude.input(session, tmpdir(), 'hold');
  assert.equal(await claude.interrupt(session), true);
  assert.deepEqual(completed, ['interrupted']);
  assert.equal(claude.active.size, 0);
});
