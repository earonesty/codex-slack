import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { expandPath } from './config.ts';
import { controlRequest } from './control.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    file: { type: 'string' }, 'state-dir': { type: 'string' }, note: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    session: { type: 'string' },
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
Each visible run creates a NEW Slack thread unless thread is explicitly set.
Use "thread":"current" (CODEX_THREAD_ID), a saved session ID or Slack root timestamp,
or --session <id>
to queue the task as a follow-up in that existing Slack thread, without a new session.
Optional condition: {"executable":"/absolute/check","args":[],"timeoutSeconds":30}.
Conditions run without a model: exit 0 fires, 1 waits, other exits/timeouts disable
the task with conditionError (get/list); no Slack thread or turn is created by checks.
Conditional tasks disarm after firing unless "repeat":true is explicitly set.
Cron sets check frequency; at checks retry every condition.pollSeconds (default 300).
condition.expiresAt defaults to 7 days; set an ISO timestamp with timezone if needed.
Use "verbosity":"verbose" to include starts, progress, and no-op results.
Agent errors, questions, and approvals remain visible in quiet mode. Condition failures
are recorded in get/list without firing the task. History retains every fired run.
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
    if (values.session) job = { ...(job as Record<string, unknown>), thread: values.session };
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
