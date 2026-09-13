import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { App } from '@slack/bolt';
import { authorized, loadConfig, record } from './config.ts';
import { Rpc } from './rpc.ts';
import { Codex } from './codex.ts';
import { Store } from './store.ts';
import { Bridge } from './bridge.ts';

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  const rpc = new Rpc(config.codexBin);
  if (process.argv.includes('--check')) {
    try {
      await rpc.start();
      const account = record(record(await rpc.request('account/read', {})).account);
      if (!Object.keys(account).length) throw new Error('Codex is not logged in. Run codex login first.');
      console.log(`Configuration valid: ${Object.keys(config.channels).length} channels. Codex handshake and login check passed. No model turn was started.`);
    } finally { rpc.close(); }
    return;
  }
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!token?.startsWith('xoxb-') || !appToken?.startsWith('xapp-')) throw new Error('Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN');
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  // Separate SQLite connection holds an OS-released crash-safe process lock.
  const lease = new DatabaseSync(path.join(config.stateDir, 'daemon-lock.sqlite'));
  try { lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch { lease.close(); throw new Error('Another bridge is already using this stateDir'); }
  const store = new Store(path.join(config.stateDir, 'bridge.sqlite'));
  const app = new App({ token, appToken, socketMode: true,
    clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000 } });
  const bridge = new Bridge(config, store, new Codex(rpc), async (binding, message) => {
    await app.client.chat.postMessage({ channel: binding.channel, thread_ts: binding.root,
      text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false, parse: 'none' });
  });
  app.event('message', async ({ body, event }) => {
    bridge.ingest(record(body).team_id, event);
  });
  app.action(/^cs:/, async ({ ack, body, action, client }) => {
    await ack();
    const payload = record(body);
    const button = record(action);
    const token = typeof button.value === 'string' ? button.value : '';
    const pending = bridge.interactions.lookup(token);
    const team = record(payload.team).id;
    const user = record(payload.user).id;
    const channel = record(payload.channel).id;
    if (!authorized(config, team, user, channel)) return;
    if (!pending || pending.binding.channel !== channel) {
      await client.chat.postEphemeral({ channel: String(channel), user: String(user), text: 'This request has expired or was already answered.' });
      return;
    }
    try {
      const choice = String(button.action_id).slice(3);
      if (choice === 'answer') {
        await client.views.open({ trigger_id: String(payload.trigger_id), view: bridge.interactions.modal(token) });
      } else bridge.interactions.choose(token, choice);
    } catch {
      await client.chat.postEphemeral({ channel: String(channel), user: String(user), text: 'Could not submit this response. Check whether Codex is still waiting, then try again.' });
    }
    await bridge.flush();
  });
  app.view('cs:answers', async ({ ack, body, view }) => {
    const pending = bridge.interactions.lookup(view.private_metadata);
    if (!pending || !authorized(config, record(body.team).id, body.user.id, pending.binding.channel)) {
      await ack({ response_action: 'errors', errors: { q0: 'This request has expired or you are not authorized.' } }); return;
    }
    try {
      bridge.interactions.answer(view.private_metadata, view.state.values);
      await ack();
    } catch {
      await ack({ response_action: 'errors', errors: { q0: 'Could not send answers. The request may have expired.' } });
    }
    await bridge.flush();
  });
  app.error(async () => { console.error('Slack handler failed; check connection and configuration.'); });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(0), 12_000);
    timeout.unref();
    await bridge.stop();
    await app.stop();
    // In-flight Slack sends are journaled as uncertain if shutdown cuts them short.
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  try {
    const auth = await app.client.auth.test();
    if (auth.team_id !== config.teamId) throw new Error('Slack token belongs to a different workspace than teamId');
    await rpc.start();
    bridge.start();
    await app.start();
    console.log(`Codex Slack listening in ${Object.keys(config.channels).length} configured channels.`);
  } catch (error) {
    rpc.close(); store.close(); lease.close();
    await app.stop().catch(() => {});
    throw error;
  }
}

main().catch(error => {
  // Do not dump SDK errors that can embed tokens or full request bodies.
  console.error(error instanceof Error && !('data' in error) ? error.message : 'Startup failed; check credentials and configuration.');
  process.exitCode = 1;
});
