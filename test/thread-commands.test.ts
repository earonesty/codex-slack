import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Rpc } from '../src/rpc.ts';
import { Codex } from '../src/codex.ts';
import { Store } from '../src/store.ts';
import { ThreadCommands } from '../src/thread-commands.ts';
import type { Config } from '../src/config.ts';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const config: Config = { root: tmpdir(), teamId: 'T123', allowedUserIds: ['U123'],
  channels: { C123: { cwd: tmpdir() } }, stateDir: '/unused', codexBin: 'unused' };
const context = { team: 'T123', user: 'U123', channel: 'C123', request: 'request-1' };

test('thread commands list a project and attach an external Codex thread to a new Slack root', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc); const store = new Store(':memory:');
  t.after(() => { rpc.close(); store.close(); });
  const thread = await codex.create(tmpdir());
  const roots: string[] = [];
  const commands = new ThreadCommands(config, store, codex, [{ channel: 'C123', cwd: tmpdir(), name: 'example' }],
    async (project, text) => { assert.equal(project.channel, 'C123'); roots.push(text); return { channel: project.channel, ts: '9.9' }; },
    async (_channel, ts) => `https://example.slack.com/archives/C123/p${ts.replace('.', '')}`);

  const listing = await commands.list(context);
  assert.match(listing, new RegExp(thread));
  assert.match(listing, /\/thread <UUID>/);

  const result = await commands.connect(context, thread);
  assert.match(result, /https:\/\/example\.slack\.com/);
  assert.match(roots[0]!, new RegExp(`Session: ${thread}`));
  assert.equal(store.get('T123:C123:9.9')?.thread, thread);
  assert.equal(store.owner('T123:C123:9.9'), 'U123');

  const again = await commands.connect({ ...context, request: 'request-2' }, 'example');
  assert.match(again, /Already connected/);
  assert.equal(roots.length, 1);
});

test('thread commands enforce operator and configured-project boundaries', async t => {
  const rpc = new Rpc(process.execPath, [fake]);
  const codex = new Codex(rpc); const store = new Store(':memory:');
  t.after(() => { rpc.close(); store.close(); });
  const commands = new ThreadCommands(config, store, codex, [{ channel: 'C123', cwd: tmpdir(), name: 'example' }],
    async () => ({ channel: 'C123', ts: '1.1' }));
  await assert.rejects(commands.list({ ...context, user: 'U999' }), /configured Codex operators/);
  await assert.rejects(commands.list({ ...context, channel: 'C999' }), /configured project channel/);
  await assert.rejects(commands.connect(context, ''), /Usage/);
});
