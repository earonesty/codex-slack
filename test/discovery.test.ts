import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { botToken, discover, resolveSettings, type Directory } from '../src/discovery.ts';

const directory: Directory = {
  teamId: 'T123', teamName: 'Workspace',
  users: [{ id: 'U123', name: 'erik', label: 'Erik Aronesty' }],
  channels: [{ id: 'C123', name: 'controller', joined: true }],
};
const settings = { users: ['@erik'], channels: { '#controller': tmpdir() } };

test('readable handles and channel names resolve without any configured IDs', () => {
  const { config, pins } = resolveSettings(settings, directory);
  assert.equal(config.teamId, 'T123');
  assert.deepEqual(config.allowedUserIds, ['U123']);
  assert.equal(config.channels.C123?.cwd, tmpdir());
  assert.equal(pins.users.erik, 'U123');
  assert.equal(pins.channels.controller, 'C123');
});

test('saved identities survive rename without giving reassigned handles authority', () => {
  const { pins } = resolveSettings(settings, directory);
  const renamed = structuredClone(directory);
  renamed.users[0]!.name = 'newname';
  renamed.users.push({ id: 'U999', name: 'erik', label: 'Different person' });
  renamed.channels[0]!.name = 'renamed';
  renamed.channels.push({ id: 'C999', name: 'controller', joined: true });
  const { config } = resolveSettings(settings, renamed, pins);
  assert.deepEqual(config.allowedUserIds, ['U123']);
  assert.deepEqual(Object.keys(config.channels), ['C123']);
  assert.throws(() => resolveSettings(settings, { ...renamed, users: renamed.users.slice(1) }, pins), /active Slack user/);
});

test('invalid people, ambiguous handles, missing membership, and wrong workspace fail closed', () => {
  assert.throws(() => resolveSettings({ ...settings, users: [] }, directory), /Set users/);
  assert.throws(() => resolveSettings({ ...settings, users: ['@stranger'] }, directory), /Could not identify/);
  assert.throws(() => resolveSettings(settings, { ...directory, users: [...directory.users, { id: 'U999', name: 'erik', label: 'Other' }] }), /Could not identify/);
  assert.throws(() => resolveSettings(settings, { ...directory, channels: [{ ...directory.channels[0]!, joined: false }] }), /Invite/);
  const { pins } = resolveSettings(settings, directory);
  assert.throws(() => resolveSettings(settings, { ...directory, teamId: 'T999' }, pins), /different Slack workspace/);
});

test('legacy ID configuration remains usable', () => {
  const { config } = resolveSettings({ teamId: 'T123', allowedUserIds: ['U123'], channels: { C123: { cwd: tmpdir() } } }, directory);
  assert.deepEqual(config.allowedUserIds, ['U123']);
  assert.equal(config.channels.C123?.cwd, tmpdir());
});

test('discovery paginates both directories and excludes bots and inactive accounts', async () => {
  const result = await discover({ apiCall: async (method, options) => {
    if (method === 'auth.test') return { ok: true, team_id: 'T123', team: 'Workspace' };
    if (method === 'users.list') return options?.cursor
      ? { members: [{ id: 'U123', name: 'erik', profile: { display_name: 'Erik' } }, { id: 'Uold', name: 'old', deleted: true }] }
      : { members: [{ id: 'B123', name: 'robot', is_bot: true }], response_metadata: { next_cursor: 'users-next' } };
    return options?.cursor
      ? { channels: [{ id: 'C123', name: 'controller', is_member: true }] }
      : { channels: [], response_metadata: { next_cursor: 'channels-next' } };
  } });
  assert.equal(result.teamName, 'Workspace');
  assert.deepEqual(result.users.map(user => user.name), ['erik']);
  assert.deepEqual(result.channels.map(channel => channel.name), ['controller']);
});

test('missing scopes explain reinstall and errors do not expose credentials', async () => {
  await assert.rejects(discover({ apiCall: async () => { throw { data: { error: 'missing_scope' }, token: 'private' }; } }), /reinstall/);
  await assert.rejects(discover({ apiCall: async () => { throw new Error('request containing private token'); } }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('private')); return true;
  });
});

test('an app-level token cannot substitute for the missing bot token', () => {
  assert.throws(() => botToken({ SLACK_APP_TOKEN: 'xapp-example' }), /Bot User OAuth Token/);
  assert.throws(() => botToken({ SLACK_BOT_TOKEN: 'xapp-example' }), /app-level token/);
  assert.equal(botToken({ SLACK_BOT_TOKEN: 'xoxb-example' }), 'xoxb-example');
});
