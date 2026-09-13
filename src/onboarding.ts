import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { View } from '@slack/types';
import { expandPath, operator, record, type Config } from './config.ts';
import type { Message } from './messages.ts';
import { Store, type ChannelSetup } from './store.ts';

export class Onboarding {
  constructor(private config: Config, private store: Store,
    private post: (channel: string, message: Message) => Promise<void>) {}

  async ask(team: unknown, channel: unknown): Promise<void> {
    if (team !== this.config.teamId || typeof channel !== 'string' || !/^[CG][A-Z0-9]+$/.test(channel)) return;
    if (Object.hasOwn(this.config.channels, channel)) return;
    const setup = this.store.ensureChannelSetup(String(team), channel);
    if (setup.cwd) {
      // Restore only for channels the bot has joined; file configuration takes precedence.
      try { this.config.channels[channel] = { cwd: this.directory(setup.cwd) }; }
      catch { console.error('A saved channel directory is unavailable; restore it before continuing.'); }
      return;
    }
    // Claim before posting to avoid duplicate welcome messages on Slack retries/restart.
    if (!this.store.claimSetupPrompt(setup.token)) return;
    await this.post(channel, this.prompt(setup.token));
  }

  async joined(team: unknown, value: unknown, botUserId: string): Promise<void> {
    const event = record(value);
    if (event.user === botUserId) await this.ask(team, event.channel);
  }

  /** An authorized !bind can recover an invitation missed while offline or an uncertain post. */
  async message(team: unknown, value: unknown): Promise<boolean> {
    const event = record(value);
    const channel = event.channel;
    if (event.bot_id || event.bot_profile || event.subtype || !operator(this.config, team, event.user)
      || typeof channel !== 'string' || !/^[CG][A-Z0-9]+$/.test(channel)) return false;
    if (typeof event.text === 'string' && event.text.trim() === '!bind') {
      if (Object.hasOwn(this.config.channels, channel)) {
        await this.post(channel, { text: 'This channel is already bound. Send a new top-level message to start a Codex session.' });
        return true;
      }
      const setup = this.store.ensureChannelSetup(String(team), channel);
      if (setup.cwd) await this.ask(team, channel);
      else {
        this.store.claimSetupPrompt(setup.token);
        await this.post(channel, this.prompt(setup.token));
      }
      return true;
    }
    if (!Object.hasOwn(this.config.channels, channel)) {
      await this.ask(team, channel);
      return true; // No Codex input until the directory is chosen; do not replay this text.
    }
    return false;
  }

  private prompt(token: string): Message {
    return {
      text: 'Which directory should I use for this channel?',
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: 'Which directory should I use for this channel? An allowed user can choose a folder on the machine running Codex.' } },
        { type: 'actions', elements: [{ type: 'button', action_id: 'bind:open', value: token, text: { type: 'plain_text', text: 'Choose directory' } }] },
      ],
    };
  }
  private pending(token: string, team: unknown, user: unknown, channel?: unknown): ChannelSetup {
    if (!operator(this.config, team, user)) throw new Error('Only configured users can bind a channel.');
    const setup = this.store.setupByToken(token);
    if (!setup || setup.team !== team || (channel !== undefined && setup.channel !== channel)) throw new Error('This channel setup is no longer available.');
    if (setup.cwd || Object.hasOwn(this.config.channels, setup.channel)) throw new Error('This channel is already bound.');
    return setup;
  }
  modal(token: string, team: unknown, user: unknown, channel: unknown): View {
    this.pending(token, team, user, channel);
    return {
      type: 'modal', callback_id: 'bind:directory', private_metadata: token,
      title: { type: 'plain_text', text: 'Bind this channel' }, submit: { type: 'plain_text', text: 'Bind' }, close: { type: 'plain_text', text: 'Cancel' },
      blocks: [{ type: 'input', block_id: 'directory', label: { type: 'plain_text', text: 'Directory on the Codex machine' },
        hint: { type: 'plain_text', text: 'An existing folder, for example ~/work/projects/dirtsignal' },
        element: { type: 'plain_text_input', action_id: 'path', max_length: 2000 } }],
    };
  }
  bind(token: string, team: unknown, user: unknown, folder: string): { channel: string; cwd: string } {
    const setup = this.pending(token, team, user);
    const cwd = this.directory(folder.trim());
    if (!this.store.saveChannelDirectory(token, cwd)) throw new Error('This channel was already bound by another request.');
    this.config.channels[setup.channel] = { cwd };
    return { channel: setup.channel, cwd };
  }
  private directory(folder: string): string {
    if (!path.isAbsolute(folder) && folder !== '~' && !folder.startsWith('~/')) throw new Error('Use an absolute path or a path starting with ~/ on the Codex machine.');
    try {
      const resolved = realpathSync(expandPath(folder));
      if (!statSync(resolved).isDirectory()) throw new Error('not a folder');
      return resolved;
    } catch { throw new Error('That directory does not exist on the Codex machine. Create it first, then try again.'); }
  }
}
