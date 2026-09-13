import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseConfig, expandPath, record, type Config } from './config.ts';

export type Member = { id: string; name: string; label: string };
export type Conversation = { id: string; name: string; joined: boolean };
export type Directory = { teamId: string; teamName: string; users: Member[]; channels: Conversation[] };
export type Pins = { teamId: string; users: Record<string, string>; channels: Record<string, string> };
type Api = { apiCall: (method: string, options?: Record<string, unknown>) => Promise<unknown> };
export const configPath = (): string => process.env.CODEX_SLACK_CONFIG ?? 'config.json';

export function botToken(env = process.env): string {
  const token = env.SLACK_BOT_TOKEN;
  if (token?.startsWith('xoxb-')) return token;
  if (token?.startsWith('xapp-')) throw new Error('SLACK_BOT_TOKEN contains an app-level token. Put it in SLACK_APP_TOKEN instead. Get the Bot User OAuth Token (xoxb-…) from Slack → OAuth & Permissions → Install to Workspace.');
  throw new Error('Missing SLACK_BOT_TOKEN. In your Slack app, open OAuth & Permissions → Install to Workspace, then copy the Bot User OAuth Token (xoxb-…) into .env as SLACK_BOT_TOKEN. Keep SLACK_APP_TOKEN too; it connects Socket Mode but cannot discover users or channels.');
}

export async function discover(api: Api): Promise<Directory> {
  async function call(method: string, options: Record<string, unknown> = {}) {
    try {
      const response = record(await api.apiCall(method, options));
      if (response.ok === false) throw { data: response };
      return response;
    } catch (error) {
      const data = record(record(error).data);
      if (data.error === 'missing_scope') throw new Error('Slack discovery needs users:read, channels:read, and groups:read. Apply the updated slack-manifest.json in Slack → App Manifest, then reinstall the app under OAuth & Permissions.');
      const code = typeof data.error === 'string' && /^[a-z_]+$/.test(data.error) ? data.error : 'connection_failed';
      throw new Error(`Slack ${method} failed (${code}). Check your bot token, app installation, and network connection.`);
    }
  }
  async function list(method: string, field: string, options: Record<string, unknown> = {}) {
    const rows: Record<string, unknown>[] = [];
    let cursor = ''; const seen = new Set<string>();
    do {
      const page = await call(method, { ...options, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page[field])) throw new Error(`Slack ${method} returned an invalid list`);
      rows.push(...page[field].map(record));
      cursor = String(record(page.response_metadata).next_cursor ?? '').trim();
      if (cursor && seen.has(cursor)) throw new Error(`Slack ${method} repeated a page cursor`);
      seen.add(cursor);
    } while (cursor);
    return rows;
  }
  const auth = await call('auth.test');
  if (typeof auth.team_id !== 'string' || !auth.team_id) throw new Error('Use a bot token installed in a single Slack workspace.');
  const [users, channels] = await Promise.all([
    list('users.list', 'members'),
    list('conversations.list', 'channels', { types: 'public_channel,private_channel', exclude_archived: true }),
  ]);
  return {
    teamId: auth.team_id, teamName: String(auth.team ?? 'Slack workspace'),
    users: users.filter(user => !user.deleted && !user.is_bot && !user.is_app_user && user.id !== 'USLACKBOT' && typeof user.id === 'string' && typeof user.name === 'string')
      .map(user => ({ id: String(user.id), name: String(user.name), label: String(record(user.profile).display_name || user.real_name || user.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    channels: channels.filter(channel => !channel.is_archived && typeof channel.id === 'string' && typeof channel.name === 'string')
      .map(channel => ({ id: String(channel.id), name: String(channel.name), joined: channel.is_member === true }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function resolveSettings(value: unknown, directory: Directory, existing?: Pins): { config: Config; pins: Pins } {
  const raw = record(value);
  if (raw.teamId && raw.teamId !== directory.teamId) throw new Error('Configured workspace does not match the bot token');
  if (existing && existing.teamId !== directory.teamId) throw new Error('This state directory belongs to a different Slack workspace. Choose a new stateDir for this workspace.');
  const pins: Pins = existing ? structuredClone(existing) : { teamId: directory.teamId, users: {}, channels: {} };
  const requestedUsers = raw.users ?? raw.allowedUserIds;
  if (!Array.isArray(requestedUsers) || !requestedUsers.length || requestedUsers.some(user => typeof user !== 'string' || !user.trim())) {
    throw new Error('Set users to Slack handles, for example ["@earonesty"], or run npm run setup to choose from a list.');
  }
  const ids = requestedUsers.map((handle: string) => {
    const key = handle.replace(/^@/, '').toLowerCase();
    const pin = Object.hasOwn(pins.users, key) ? pins.users[key] : undefined;
    const matches = directory.users.filter(user => pin ? user.id === pin : user.id === handle || user.name.toLowerCase() === key);
    if (matches.length !== 1) throw new Error(`Could not identify active Slack user @${key}. Run npm run discover to list handles; display names are not necessarily handles.`);
    Object.defineProperty(pins.users, key, { value: matches[0]!.id, writable: true, configurable: true, enumerable: true });
    return matches[0]!.id;
  });
  const channels: Record<string, { cwd: unknown }> = {};
  for (const [name, setting] of Object.entries(record(raw.channels))) {
    const key = name.replace(/^#/, '').toLowerCase();
    const pin = Object.hasOwn(pins.channels, key) ? pins.channels[key] : undefined;
    const matches = directory.channels.filter(channel => pin ? channel.id === pin : channel.id === name || channel.name.toLowerCase() === key);
    if (matches.length !== 1) throw new Error(`Cannot find #${key}. Invite the bot to that channel (required for private channels), then run npm run discover.`);
    const channel = matches[0]!;
    if (!channel.joined) throw new Error(`Invite the Codex bot to #${channel.name} in Slack, then retry.`);
    if (Object.hasOwn(channels, channel.id)) throw new Error(`Channel #${channel.name} is configured twice`);
    Object.defineProperty(pins.channels, key, { value: channel.id, writable: true, configurable: true, enumerable: true });
    channels[channel.id] = { cwd: typeof setting === 'string' ? setting : record(setting).cwd };
  }
  return { config: parseConfig({ ...raw, teamId: directory.teamId, allowedUserIds: ids, channels }), pins };
}

export function loadResolvedConfig(directory: Directory): Config {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configPath(), 'utf8')); }
  catch (error) {
    if (record(error).code === 'ENOENT') throw new Error('No config.json yet. Run npm run setup to choose yourself and your channels.');
    throw new Error('Could not read config.json. Check its JSON syntax.');
  }
  const stateDir = expandPath(String(record(raw).stateDir ?? '~/.local/state/codex-slack'));
  const pinPath = path.join(stateDir, 'identities.json');
  let existing: Pins | undefined;
  try {
    const data = JSON.parse(readFileSync(pinPath, 'utf8'));
    if (typeof data.teamId !== 'string' || !data.users || !data.channels) throw new Error('invalid');
    existing = data as Pins;
  } catch (error) { if (record(error).code !== 'ENOENT') throw new Error('Cannot read the saved Slack identity bindings; restore identities.json from a backup.'); }
  const { config, pins } = resolveSettings(raw, directory, existing);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${pinPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(pins, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, pinPath);
  return config;
}
