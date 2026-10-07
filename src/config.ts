import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type Channel = { cwd: string };
export type AgentConfig = { driver: 'codex' | 'claude'; command: string };
export type GithubTriageSkipRule = Partial<Record<'author' | 'title' | 'repo' | 'label' | 'body', string>>;
export type GithubConfig = { channel: string; owners: string[]; include: string[]; exclude: string[]; intervalSeconds: number; batchSize: number; codexHome?: string; skipTriage?: GithubTriageSkipRule[]; excludePullRequestAuthors?: string[] };
export type Config = {
  root: string;
  teamId: string;
  allowedUserIds: string[];
  channels: Record<string, Channel>;
  stateDir: string;
  agent: AgentConfig;
  scheduledBrowserUse: boolean;
  github?: GithubConfig;
};

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function expandPath(value: string): string {
  return path.resolve(value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
}

/** Validate resolved IDs, filesystem boundaries, agent settings, and optional integrations. */
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
  if (raw.scheduledBrowserUse !== undefined && typeof raw.scheduledBrowserUse !== 'boolean') throw new Error('scheduledBrowserUse must be boolean');
  let github: GithubConfig | undefined;
  if (raw.github !== undefined) {
    if (driver !== 'codex') throw new Error('github feed requires the Codex driver for enforced read-only triage');
    if (!raw.github || typeof raw.github !== 'object' || Array.isArray(raw.github)) throw new Error('Invalid github configuration');
    const feed = record(raw.github);
    if (typeof feed.channel !== 'string' || !channels[feed.channel]) throw new Error('github.channel must be a bound Slack channel');
    const names = (field: string, pattern: RegExp): string[] => {
      const values = feed[field] ?? [];
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !pattern.test(value))) throw new Error(`Invalid github.${field}`);
      return [...new Set(values.map(value => String(value).toLowerCase()))];
    };
    const owners = names('owners', /^[a-z0-9][a-z0-9-]*$/i);
    if (!owners.length) throw new Error('github.owners must identify primary-maintainer accounts/organizations');
    const include = names('include', /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i);
    const exclude = names('exclude', /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i);
    const intervalSeconds = feed.intervalSeconds ?? 300;
    const batchSize = feed.batchSize ?? 3;
    if (!Number.isInteger(intervalSeconds) || Number(intervalSeconds) < 60) throw new Error('github.intervalSeconds must be an integer >= 60');
    if (!Number.isInteger(batchSize) || Number(batchSize) < 1 || Number(batchSize) > 10) throw new Error('github.batchSize must be between 1 and 10');
    github = { channel: feed.channel, owners, include, exclude, intervalSeconds: Number(intervalSeconds), batchSize: Number(batchSize) };
    if (feed.codexHome !== undefined) {
      if (typeof feed.codexHome !== 'string' || !feed.codexHome.trim()) throw new Error('Invalid github.codexHome');
      const codexHome = realpathSync(expandPath(feed.codexHome));
      if (!statSync(codexHome).isDirectory()) throw new Error('github.codexHome must be a directory');
      github.codexHome = codexHome;
    }
    if (feed.excludePullRequestAuthors !== undefined) {
      if (!Array.isArray(feed.excludePullRequestAuthors)) throw new Error('Invalid github.excludePullRequestAuthors');
      github.excludePullRequestAuthors = names('excludePullRequestAuthors', /^[a-z0-9][a-z0-9-]*(?:\[bot\])?$/i);
    }
    if (feed.skipTriage !== undefined) {
      if (!Array.isArray(feed.skipTriage)) throw new Error('github.skipTriage must be an array of regex rules');
      github.skipTriage = feed.skipTriage.map((value, index) => {
        const entries = Object.entries(record(value));
        if (!entries.length) throw new Error(`github.skipTriage[${index}] must contain at least one regex field`);
        for (const [field, pattern] of entries) {
          if (!['author', 'title', 'repo', 'label', 'body'].includes(field) || typeof pattern !== 'string' || !pattern.length) throw new Error(`Invalid github.skipTriage[${index}].${field}`);
          try { new RegExp(pattern, 'i'); }
          catch { throw new Error(`Invalid regex in github.skipTriage[${index}].${field}`); }
        }
        return Object.fromEntries(entries) as GithubTriageSkipRule;
      });
    }
  }
  return {
    root, teamId: raw.teamId, allowedUserIds: raw.allowedUserIds as string[], channels,
    stateDir: expandPath(raw.stateDir as string ?? '~/.local/state/codex-slack'),
    agent: { driver, command: String(agentRaw.command ?? raw.codexBin ?? driver) },
    scheduledBrowserUse: raw.scheduledBrowserUse as boolean ?? true,
    ...(github ? { github } : {}),
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
