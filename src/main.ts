import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { authorized, record } from './config.ts';
import { botToken, discover, loadResolvedConfig } from './discovery.ts';
import { printDirectory, setup } from './setup.ts';
import { Rpc } from './rpc.ts';
import { Codex } from './codex.ts';
import { Store } from './store.ts';
import { Bridge } from './bridge.ts';
import { Onboarding } from './onboarding.ts';
import { ScheduleStore } from './schedule-store.ts';
import { Scheduler } from './scheduler.ts';
import { listenControl } from './control.ts';
import type { Server } from 'node:net';

async function main(): Promise<void> {
  process.umask(0o077);
  const token = botToken();
  const directory = await discover(new WebClient(token, { retryConfig: { retries: 0 }, timeout: 10_000 }));
  if (process.argv.includes('--discover')) { printDirectory(directory); return; }
  if (process.argv.includes('--setup')) { await setup(directory); return; }
  const config = loadResolvedConfig(directory);
  const rpc = new Rpc(config.codexBin);
  if (process.argv.includes('--check')) {
    try {
      await rpc.start();
      const account = record(record(await rpc.request('account/read', {})).account);
      if (!Object.keys(account).length) throw new Error('Codex is not logged in. Run codex login first.');
      console.log(`Connected to ${directory.teamName}: ${Object.keys(config.channels).length} channel bindings validated. Codex handshake and login check passed. No model turn was started.`);
    } finally { rpc.close(); }
    return;
  }
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!appToken?.startsWith('xapp-')) throw new Error('Set SLACK_APP_TOKEN to an app-level token (xapp-…) from Basic Information → App-Level Tokens, with connections:write.');
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
  }, async (binding, status) => {
    await app.client.assistant.threads.setStatus({ channel_id: binding.channel, thread_ts: binding.root, status });
  });
  const onboarding = new Onboarding(config, store, async (channel, message) => {
    await app.client.chat.postMessage({ channel, text: message.text, blocks: message.blocks,
      unfurl_links: false, unfurl_media: false, parse: 'none' });
  }, channels => { void bridge.disableChannels(channels); });
  const scheduleStore = new ScheduleStore(path.join(config.stateDir, 'schedules.sqlite'));
  const scheduler = new Scheduler(bridge, scheduleStore, async (channel, text) => {
    const result = await app.client.chat.postMessage({ channel, text,
      blocks: [{ type: 'section', text: { type: 'plain_text', text } }],
      unfurl_links: false, unfurl_media: false, parse: 'none' });
    if (!result.ts) throw new Error('Slack returned no message timestamp');
    return result.ts;
  });
  let control: Server | undefined;
  app.event('member_joined_channel', async ({ body, event, context }) => {
    await onboarding.joined(record(body).team_id, event, directory.botUserId ?? context.botUserId ?? '');
  });
  app.event('message', async ({ body, event }) => {
    const team = record(body).team_id;
    if (!await onboarding.message(team, event)) bridge.ingest(team, event);
  });
  app.action('bind:open', async ({ ack, body, action, client }) => {
    await ack();
    const payload = record(body);
    const channel = record(payload.channel).id;
    const user = record(payload.user).id;
    try {
      const view = onboarding.modal(String(record(action).value), record(payload.team).id, user, channel);
      await client.views.open({ trigger_id: String(payload.trigger_id), view });
    } catch {
      await client.chat.postEphemeral({ channel: String(channel), user: String(user),
        text: 'Only configured users can choose a directory. This channel may already be bound; otherwise try !bind again.' });
    }
  });
  app.view('bind:directory', async ({ ack, body, view }) => {
    try {
      const confirmation = onboarding.preview(view.private_metadata, record(body.team).id, body.user.id,
        view.state.values.directory?.path?.value ?? '');
      await ack({ response_action: 'update', view: confirmation });
    } catch (error) {
      await ack({ response_action: 'errors', errors: { directory: error instanceof Error ? error.message : 'Could not save this binding.' } });
    }
  });
  app.view('bind:confirm', async ({ ack, body, view }) => {
    let binding: { channel: string; cwd: string };
    try {
      if (!view.state.values.directory?.confirm?.selected_options?.some(option => option.value === 'yes')) throw new Error('Confirm the binding before saving.');
      binding = onboarding.confirm(view.private_metadata, record(body.team).id, body.user.id);
    } catch (error) {
      await ack({ response_action: 'errors', errors: { directory: error instanceof Error ? error.message : 'Could not save this binding.' } });
      return;
    }
    await ack();
    await app.client.chat.postMessage({ channel: binding.channel,
      text: 'Directory saved. Send a new top-level message to start a Codex session.',
      blocks: [{ type: 'section', text: { type: 'plain_text', text: `Bound to ${binding.cwd}. Send a new top-level message to start a Codex session.` } }],
      unfurl_links: false, unfurl_media: false, parse: 'none' });
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
    if (!pending || pending.binding.channel !== channel || !bridge.enabled(pending.binding)) {
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
    if (!pending || !bridge.enabled(pending.binding) || !authorized(config, record(body.team).id, body.user.id, pending.binding.channel)) {
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
    scheduler.stop();
    control?.close();
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
    await rpc.start();
    for (const channel of directory.channels.filter(channel => channel.joined)) {
      await onboarding.ask(config.teamId, channel.id);
    }
    bridge.start();
    await app.start();
    control = await listenControl(path.join(config.stateDir, 'control.sock'), value => scheduler.command(value));
    scheduler.start();
    console.log(`Codex Slack listening in ${Object.keys(config.channels).length} configured channels.`);
  } catch (error) {
    scheduler.stop(); control?.close();
    rpc.close(); scheduleStore.close(); store.close(); lease.close();
    await app.stop().catch(() => {});
    throw error;
  }
}

main().catch(error => {
  // Do not dump SDK errors that can embed tokens or full request bodies.
  console.error(error instanceof Error && !('data' in error) ? error.message : 'Startup failed; check credentials and configuration.');
  process.exitCode = 1;
});
