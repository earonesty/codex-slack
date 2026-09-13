import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { View } from '@slack/types';
import { allowedDirectory, operator, record, type Config } from './config.ts';
import type { Message } from './messages.ts';
import { Store, type ChannelSetup } from './store.ts';

export class Onboarding {
  private confirmations = new Map<string, { token: string; team: unknown; user: unknown; cwd: string; displaced: string[]; expires: number }>();
  constructor(private config: Config, private store: Store,
    private post: (channel: string, message: Message) => Promise<void>,
    private displaced: (channels: string[]) => void = () => {}) {
    const overrides = store.overrides(config.teamId);
    for (const saved of overrides) delete config.channels[saved.channel];
    for (const saved of overrides) if (saved.cwd) {
      for (const [channel, binding] of Object.entries(config.channels)) if (binding.cwd === saved.cwd) delete config.channels[channel];
    }
  }

  async ask(team: unknown, channel: unknown): Promise<void> {
    if (team !== this.config.teamId || typeof channel !== 'string' || !/^[CG][A-Z0-9]+$/.test(channel)) return;
    if (Object.hasOwn(this.config.channels, channel)) return;
    const setup = this.store.ensureChannelSetup(String(team), channel);
    const override = this.store.overrides(String(team)).find(row => row.channel === channel);
    const saved = override ? override.cwd : setup.cwd;
    if (saved) {
      // Restore only for channels the bot has joined, using saved ownership decisions.
      try {
        const cwd = this.directory(saved);
        if (Object.values(this.config.channels).some(binding => binding.cwd === cwd)) throw new Error('Duplicate saved binding');
        this.config.channels[channel] = { cwd };
      }
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
  preview(token: string, team: unknown, user: unknown, folder: string): View {
    this.pending(token, team, user);
    const cwd = this.directory(folder.trim());
    const displaced = this.conflicts(cwd);
    const id = randomUUID();
    for (const [key, value] of this.confirmations) if (value.expires < Date.now()) this.confirmations.delete(key);
    this.confirmations.set(id, { token, team, user, cwd, displaced, expires: Date.now() + 600_000 });
    return { type: 'modal', callback_id: 'bind:confirm', private_metadata: id,
      title: { type: 'plain_text', text: 'Confirm binding' }, submit: { type: 'plain_text', text: 'Bind' },
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: `Bind this channel to ${cwd}?` } },
        { type: 'section', text: { type: 'mrkdwn', text: displaced.length
          ? `This will unbind ${displaced.map(channel => `<#${channel}>`).join(', ')} and disable their existing threads and queued work. Active work will be interrupted (already-running tools may finish).`
          : 'No other channel will be unbound. Nested project bindings are unchanged.' } },
        { type: 'input', block_id: 'directory', label: { type: 'plain_text', text: 'Confirm' }, element: {
          type: 'checkboxes', action_id: 'confirm', options: [{ text: { type: 'plain_text', text: 'Apply this binding' }, value: 'yes' }],
        } },
      ] };
  }
  confirm(id: string, team: unknown, user: unknown): { channel: string; cwd: string } {
    const pending = this.confirmations.get(id);
    if (!pending || pending.team !== team || pending.user !== user || pending.expires < Date.now()) throw new Error('Confirmation expired. Close this dialog and use !bind again.');
    const result = this.bind(pending.token, team, user, pending.cwd, pending.displaced);
    this.confirmations.delete(id);
    return result;
  }
  private conflicts(cwd: string): string[] {
    return [...new Set([
      ...Object.entries(this.config.channels).filter(([, binding]) => binding.cwd === cwd).map(([channel]) => channel),
      ...this.store.channelSetups(this.config.teamId).filter(row => row.cwd === cwd).map(row => row.channel),
      ...this.store.overrides(this.config.teamId).filter(row => row.cwd === cwd).map(row => row.channel),
    ])].sort();
  }
  bind(token: string, team: unknown, user: unknown, folder: string, confirmed: string[] = []): { channel: string; cwd: string } {
    const setup = this.pending(token, team, user);
    const cwd = this.directory(folder.trim());
    const displaced = this.conflicts(cwd);
    if (JSON.stringify(displaced) !== JSON.stringify(confirmed)) throw new Error('Directory ownership changed. Close this dialog and use !bind to review the affected channels.');
    this.store.replaceDirectory(token, cwd, displaced);
    for (const channel of displaced) delete this.config.channels[channel];
    this.config.channels[setup.channel] = { cwd };
    this.displaced(displaced);
    return { channel: setup.channel, cwd };
  }
  private directory(folder: string): string {
    if (!path.isAbsolute(folder) && folder !== '~' && !folder.startsWith('~/')) throw new Error('Use an absolute path or a path starting with ~/ on the Codex machine.');
    try { return allowedDirectory(this.config.root, folder); }
    catch (error) {
      if (error instanceof Error && error.message.includes('configured root')) throw error;
      throw new Error('That directory does not exist on the Codex machine. Create it first, then try again.');
    }
  }
}
