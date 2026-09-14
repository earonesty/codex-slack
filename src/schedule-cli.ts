import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { expandPath } from './config.ts';
import { controlRequest } from './control.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    file: { type: 'string' }, 'state-dir': { type: 'string' }, note: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const [action, id] = positionals;
  if (values.help || !action) {
    console.log(`Usage: codex-slack-schedule <action> [id] [options]

status                         Daemon health, linked directories, local timezone
list                           List saved schedules
put --file task.json            Create/update by the task's stable id; use - for stdin
get <id>                       Inspect a schedule
pause <id> / resume <id>        Disable/enable future occurrences
remove <id>                    Remove schedule; retains history and active sessions
run <id>                       Run once now without changing the schedule (starts work)
history [id]                   Latest 30 runs, session IDs, final output and errors
resolve <run-id> --note "..."   Clear an uncertain run after inspecting what happened

Optional --state-dir overrides CODEX_SLACK_STATE_DIR or ~/.local/state/codex-slack.
Task JSON: {"id":"weekly-log-check","name":"Weekly log check","cwd":"/project",
"cron":"0 9 * * 1","timezone":"America/Los_Angeles","prompt":"Check logs..."}
Use "at":"2026-10-01T09:00:00-07:00" instead of cron for one-shot tasks.
channel defaults to the closest linked directory; null keeps results local.
verbosity defaults to quiet: no start/progress posts or [SILENT] no-op results.
Use "verbosity":"verbose" to include starts, progress, and no-op results.
Errors, questions, and approvals remain visible in quiet mode. History retains every run.
enabled defaults to true for new tasks. put replaces the full task definition.
The daemon runs the timer. No crontab entry or daemon restart is needed for tasks.`);
    return;
  }
  if (positionals.length > 2) throw new Error('Too many arguments');
  if (!['status', 'list', 'put', 'get', 'pause', 'resume', 'remove', 'run', 'history', 'resolve'].includes(action)) throw new Error('Unknown action; use --help');
  let job: unknown;
  if (action === 'put') {
    if (!values.file) throw new Error('put requires --file task.json (or --file -)');
    job = JSON.parse(readFileSync(values.file === '-' ? 0 : values.file, 'utf8'));
  }
  const stateDir = expandPath(values['state-dir'] ?? process.env.CODEX_SLACK_STATE_DIR ?? '~/.local/state/codex-slack');
  const result = await controlRequest(path.join(stateDir, 'control.sock'), {
    action, id, job, note: values.note, contextThread: process.env.CODEX_THREAD_ID,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code === 'ENOENT' || code === 'ECONNREFUSED'
    ? 'Slack scheduler is not available. Check codex-slack.service and the configured state directory.'
    : error instanceof Error ? error.message : 'Scheduling command failed');
  process.exitCode = 1;
});
