import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { expandPath, record } from './config.ts';
import { controlRequest } from './control.ts';
import { Store } from './store.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    session: { type: 'string' }, 'state-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log(`Usage: codex-slack-restart [status] [--session <Codex thread ID>] [--state-dir <directory>]

Without 'status', save a restart handoff and ask systemd to restart the bridge in 5 seconds.
The new daemon queues a readiness notification into the same saved Codex session.
The session defaults to CODEX_THREAD_ID. Requires a live bridge and user systemd access.
If execution is interrupted, inspect status instead of issuing another restart.
State directory defaults to CODEX_SLACK_STATE_DIR or ~/.local/state/codex-slack.`);
    return;
  }
  if (positionals.length > 1 || (positionals[0] && positionals[0] !== 'status')) throw new Error('Unknown action; use --help');
  const stateDir = expandPath(values['state-dir'] ?? process.env.CODEX_SLACK_STATE_DIR ?? '~/.local/state/codex-slack');
  const dbPath = path.join(stateDir, 'bridge.sqlite');
  if (!existsSync(dbPath)) throw new Error('Bridge state does not exist; check --state-dir.');
  const store = new Store(dbPath);
  try {
    if (positionals[0] === 'status') { console.log(JSON.stringify(store.latestRestart() ?? null, null, 2)); return; }
    const pending = store.pendingRestart();
    if (pending) {
      console.log(JSON.stringify({ ...pending, message: 'Already pending. No additional restart was requested.' }, null, 2));
      return;
    }
    const thread = values.session ?? process.env.CODEX_THREAD_ID;
    if (!thread) throw new Error('Pass --session or run from a Slack-linked Codex session.');
    const status = record(await controlRequest(path.join(stateDir, 'control.sock'), { action: 'status' }));
    if (status.scheduler !== 'ready' || status.active !== 0) throw new Error('Scheduler must be ready with no active or uncertain scheduled runs before restart.');
    const invocation = execFileSync('systemctl', ['--user', 'show', 'codex-slack.service', '-p', 'InvocationID', '--value'],
      { encoding: 'utf8', timeout: 5_000 }).trim();
    if (!/^[a-f0-9]{32}$/.test(invocation)) throw new Error('Could not identify the running service invocation.');
    const restart = store.prepareRestart(thread, invocation);
    const helper = fileURLToPath(new URL('../contrib/restart-and-check.mjs', import.meta.url));
    try {
      // A transient user timer/service belongs to systemd, outside codex-slack.service's cgroup.
      execFileSync('systemd-run', ['--user', `--unit=codex-slack-restart-${restart.id}`, '--on-active=5s', '--collect',
        process.execPath, helper, stateDir], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // A lost acknowledgement may still have installed the timer. Preserve intent; never retry automatically.
      throw new Error(`Could not confirm the restart timer for ${restart.id}. The handoff remains pending; inspect systemd and restart status before retrying.`);
    }
    console.log(JSON.stringify({ ...restart, message: 'Restart scheduled in 5 seconds. The new daemon will notify this session when ready.' }, null, 2));
  } finally { store.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Restart request failed');
  process.exitCode = 1;
});
