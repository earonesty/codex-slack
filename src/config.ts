import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type Channel = { cwd: string };
export type Config = {
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
  for (const [id, value] of Object.entries(record(raw.channels))) {
    const cwd = record(value).cwd;
    if (!/^[CG][A-Z0-9]+$/.test(id) || typeof cwd !== 'string' || !cwd.trim()) throw new Error(`Invalid channel configuration: ${id}`);
    const resolved = realpathSync(expandPath(cwd));
    if (!statSync(resolved).isDirectory()) throw new Error(`Channel ${id} cwd is not a directory`);
    channels[id] = { cwd: resolved };
  }
  if (!Object.keys(channels).length) throw new Error('At least one channel binding is required');
  if (raw.stateDir !== undefined && (typeof raw.stateDir !== 'string' || !raw.stateDir.trim())) throw new Error('Invalid stateDir');
  if (raw.codexBin !== undefined && (typeof raw.codexBin !== 'string' || !raw.codexBin.trim())) throw new Error('Invalid codexBin');
  return {
    teamId: raw.teamId, allowedUserIds: raw.allowedUserIds as string[], channels,
    stateDir: expandPath(raw.stateDir as string ?? '~/.local/state/codex-slack'),
    codexBin: raw.codexBin as string ?? 'codex',
  };
}

export function authorized(config: Config, team: unknown, user: unknown, channel: unknown): boolean {
  return team === config.teamId && typeof user === 'string' && config.allowedUserIds.includes(user)
    && typeof channel === 'string' && Object.hasOwn(config.channels, channel);
}
