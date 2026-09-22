import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type Channel = { cwd: string };
export type AgentConfig = { driver: 'codex' | 'claude'; command: string };
export type Config = {
  root: string;
  teamId: string;
  allowedUserIds: string[];
  channels: Record<string, Channel>;
  stateDir: string;
  agent: AgentConfig;
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
  if (raw.agent !== undefined && (typeof raw.agent !== 'object' || raw.agent === null || Array.isArray(raw.agent))) throw new Error('Invalid agent');
  const agentRaw = record(raw.agent);
  const driver = agentRaw.driver ?? 'codex';
  if (driver !== 'codex' && driver !== 'claude') throw new Error('agent.driver must be codex or claude');
  if (agentRaw.command !== undefined && (typeof agentRaw.command !== 'string' || !agentRaw.command.trim())) throw new Error('Invalid agent.command');
  if (raw.codexBin !== undefined && (typeof raw.codexBin !== 'string' || !raw.codexBin.trim())) throw new Error('Invalid codexBin');
  if (raw.codexBin !== undefined && raw.agent !== undefined) throw new Error('Use agent.command instead of codexBin when agent is configured');
  return {
    root, teamId: raw.teamId, allowedUserIds: raw.allowedUserIds as string[], channels,
    stateDir: expandPath(raw.stateDir as string ?? '~/.local/state/codex-slack'),
    agent: { driver, command: String(agentRaw.command ?? raw.codexBin ?? driver) },
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
