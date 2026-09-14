import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ThreadStatus } from '../src/thread-status.ts';
import type { Binding } from '../src/store.ts';

const binding = { key: 'T:C:1.1', channel: 'C', root: '1.1', cwd: '/tmp', thread: 'thread' } as Binding;

test('status survives intermediate replies and refreshes until cleared', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls: string[] = [];
  const status = new ThreadStatus(async (_, value) => { calls.push(value); }, 15);
  try {
    status.set(binding, true);
    await sleep(0);
    assert.deepEqual(calls, ['is working…']);
    status.afterMessage(binding);
    await sleep(0);
    assert.equal(calls.length, 2);
    t.mock.timers.tick(30);
    await sleep(0);
    assert.ok(calls.length > 2);
    await status.clear();
    assert.equal(calls.at(-1), '');
    const count = calls.length;
    status.afterMessage(binding);
    t.mock.timers.tick(30);
    await sleep(0);
    assert.equal(calls.length, count);
  } finally { await status.clear(); }
});

test('completion wins over an in-flight update and queued refresh', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const status = new ThreadStatus(async (_, value) => {
    calls.push(value);
    if (calls.length === 1) await blocked;
  });
  status.set(binding, true);
  await sleep(0);
  status.afterMessage(binding);
  const clearing = status.clear();
  release();
  await clearing;
  assert.equal(calls[0], 'is working…');
  assert.ok(calls.slice(1).every(value => value === ''));
});

test('failed status calls do not prevent cleanup or other threads', async () => {
  const calls: string[] = [];
  const status = new ThreadStatus(async (current, value) => {
    calls.push(`${current.key}:${value}`);
    if (current.key === binding.key && value) throw new Error('unavailable');
  });
  status.set(binding, true);
  status.set({ ...binding, key: 'T:C:2.2', root: '2.2' }, true);
  await sleep(0);
  await status.clear();
  assert.ok(calls.includes('T:C:2.2:is working…'));
  assert.ok(calls.includes('T:C:1.1:'));
  assert.ok(calls.includes('T:C:2.2:'));
});
