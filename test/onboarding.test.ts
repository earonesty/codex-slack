import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Onboarding } from '../src/onboarding.ts';
import { Store } from '../src/store.ts';
import { authorized, type Config } from '../src/config.ts';
import { resolveSettings } from '../src/discovery.ts';

function fixture() {
  const config: Config = { teamId: 'T123', allowedUserIds: ['U123'], channels: {}, stateDir: tmpdir(), codexBin: 'codex' };
  const store = new Store(':memory:');
  const posts: string[] = [];
  const onboarding = new Onboarding(config, store, async channel => { posts.push(channel); });
  return { config, store, posts, onboarding };
}

test('users-only configuration supports onboarding before any channel is bound', () => {
  const { config } = resolveSettings({ users: ['@erik'] }, {
    teamId: 'T123', teamName: 'Workspace', users: [{ id: 'U123', name: 'erik', label: 'Erik' }], channels: [],
  });
  assert.deepEqual(config.channels, {});
});

test('only bot invitations in this workspace prompt, once per unbound channel', async () => {
  const { config, store, posts, onboarding } = fixture();
  try {
    config.channels.C999 = { cwd: tmpdir() };
    await onboarding.joined('T123', { user: 'U123', channel: 'C123' }, 'UBOT');
    await onboarding.joined('T999', { user: 'UBOT', channel: 'C123' }, 'UBOT');
    await onboarding.joined('T123', { user: 'UBOT', channel: 'C999' }, 'UBOT');
    assert.equal(posts.length, 0);
    await onboarding.joined('T123', { user: 'UBOT', channel: 'C123' }, 'UBOT');
    await onboarding.joined('T123', { user: 'UBOT', channel: 'C123' }, 'UBOT');
    assert.deepEqual(posts, ['C123']);
  } finally { store.close(); }
});

test('both controls enforce allowed users and workspace; paths and stale submissions are validated', async () => {
  const { config, store, onboarding } = fixture();
  try {
    await onboarding.ask('T123', 'C123');
    const token = store.channelSetups('T123')[0]!.token;
    assert.throws(() => onboarding.modal(token, 'T123', 'U999', 'C123'), /Only configured/);
    assert.throws(() => onboarding.modal(token, 'T123', 'U123', 'C999'), /no longer/);
    assert.throws(() => onboarding.bind(token, 'T999', 'U123', tmpdir()), /Only configured/);
    assert.throws(() => onboarding.bind(token, 'T123', 'U999', tmpdir()), /Only configured/);
    assert.throws(() => onboarding.bind(token, 'T123', 'U123', 'relative'), /absolute/);
    assert.throws(() => onboarding.bind(token, 'T123', 'U123', '/nonexistent-codex-slack-test-folder'), /does not exist/);
    assert.throws(() => onboarding.bind(token, 'T123', 'U123', path.resolve('package.json')), /does not exist/);
    assert.equal(authorized(config, 'T123', 'U123', 'C123'), false);
    assert.equal(onboarding.modal(token, 'T123', 'U123', 'C123').type, 'modal');
    onboarding.bind(token, 'T123', 'U123', tmpdir());
    assert.equal(config.channels.C123?.cwd, realpathSync(tmpdir()));
    assert.equal(authorized(config, 'T123', 'U123', 'C123'), true);
    assert.throws(() => onboarding.bind(token, 'T123', 'U123', tmpdir()), /already bound/);
  } finally { store.close(); }
});

test('unbound authorized messages are consumed, and !bind recovers a failed prompt', async () => {
  const { config, store, posts, onboarding } = fixture();
  try {
    assert.equal(await onboarding.message('T123', { user: 'U999', channel: 'C123', text: '!bind' }), false);
    assert.equal(posts.length, 0);
    const failed = new Onboarding(config, store, async () => { throw new Error('network'); });
    await assert.rejects(failed.ask('T123', 'C123'), /network/);
    await onboarding.ask('T123', 'C123');
    assert.equal(posts.length, 0);
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: '!bind' }), true);
    assert.equal(posts.length, 1);
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: 'do work' }), true);
    onboarding.bind(store.channelSetups('T123')[0]!.token, 'T123', 'U123', tmpdir());
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: '!bind' }), true);
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: 'do work' }), false);
  } finally { store.close(); }
});

test('pending controls and directory bindings survive restart; manual config wins', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-slack-onboarding-'));
  const config: Config = { teamId: 'T123', allowedUserIds: ['U123'], channels: {}, stateDir: dir, codexBin: 'codex' };
  let store = new Store(path.join(dir, 'bridge.sqlite'));
  const posts: string[] = [];
  const post = async (channel: string) => { posts.push(channel); };
  try {
    await new Onboarding(config, store, post).ask('T123', 'C123');
    const token = store.channelSetups('T123')[0]!.token;
    store.close(); store = new Store(path.join(dir, 'bridge.sqlite'));
    const restored = new Onboarding(config, store, post);
    await restored.ask('T123', 'C123');
    assert.equal(posts.length, 1);
    restored.bind(token, 'T123', 'U123', tmpdir());
    store.close(); store = new Store(path.join(dir, 'bridge.sqlite'));
    config.channels = {};
    await new Onboarding(config, store, post).ask('T123', 'C123');
    assert.equal(config.channels.C123?.cwd, realpathSync(tmpdir()));
    config.channels.C123 = { cwd: dir };
    await new Onboarding(config, store, post).ask('T123', 'C123');
    assert.equal(config.channels.C123.cwd, dir);
    assert.equal(posts.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('!bind as the first message prevents a second automatic welcome', async () => {
  const { store, posts, onboarding } = fixture();
  try {
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: ' !bind ' }), true);
    await onboarding.ask('T123', 'C123');
    assert.equal(posts.length, 1);
  } finally { store.close(); }
});
