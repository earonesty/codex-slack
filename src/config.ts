import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type Channel = { cwd: string };
export type Config = {
  root: string;
  teamId: string;
  allowedUserIds: string[];
  channels: Record<string, Channel>;
  stateDir: string;
  codexBin: string;
};

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function expandPath(value: string): string {
  return path.resolve(value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
}

export function parseConfig(value: unknown): Config {
  const raw = record(value);
  if (typeof raw.teamId !== 'string' || !/^T[A-Z0-9]+$/.test(raw.teamId)) throw new Error('teamId must be a Slack workspace ID');
  if (!Array.isArray(raw.allowedUserIds) || !raw.allowedUserIds.length || raw.allowedUserIds.some(id => typeof id !== 'string' || !/^[UW][A-Z0-9]+$/.test(id))) {
    throw new Error('allowedUserIds must contain explicit Slack member IDs');
  }
  const channels: Record<string, Channel> = {};
  if (raw.root !== undefined && (typeof raw.root !== 'string' || !raw.root.trim())) throw new Error('Invalid root');
  const root = realpathSync(expandPath(raw.root as string ?? '~'));
  if (!statSync(root).isDirectory()) throw new Error('root must be a directory');
  for (const [id, value] of Object.entries(record(raw.channels))) {
    const cwd = record(value).cwd;
    if (!/^[CG][A-Z0-9]+$/.test(id) || typeof cwd !== 'string' || !cwd.trim()) throw new Error(`Invalid channel configuration: ${id}`);
    const resolved = realpathSync(expandPath(cwd));
    if (!statSync(resolved).isDirectory()) throw new Error(`Channel ${id} cwd is not a directory`);
    allowedDirectory(root, resolved);
    if (Object.values(channels).some(channel => channel.cwd === resolved)) throw new Error('Only one channel can bind each directory');
    channels[id] = { cwd: resolved };
  }
  if (raw.stateDir !== undefined && (typeof raw.stateDir !== 'string' || !raw.stateDir.trim())) throw new Error('Invalid stateDir');
  if (raw.codexBin !== undefined && (typeof raw.codexBin !== 'string' || !raw.codexBin.trim())) throw new Error('Invalid codexBin');
  return {
    root, teamId: raw.teamId, allowedUserIds: raw.allowedUserIds as string[], channels,
    stateDir: expandPath(raw.stateDir as string ?? '~/.local/state/codex-slack'),
    codexBin: raw.codexBin as string ?? 'codex',
  };
}

export function allowedDirectory(root: string, folder: string): string {
  const resolved = realpathSync(expandPath(folder));
  if (!statSync(resolved).isDirectory()) throw new Error('Directory does not exist.');
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Directory must be inside the configured root.');
  return resolved;
}

export function authorized(config: Config, team: unknown, user: unknown, channel: unknown): boolean {
  return operator(config, team, user)
    && typeof channel === 'string' && Object.hasOwn(config.channels, channel);
}

export function operator(config: Config, team: unknown, user: unknown): boolean {
  return team === config.teamId && typeof user === 'string' && config.allowedUserIds.includes(user);
}
