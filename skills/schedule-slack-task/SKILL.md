---
name: schedule-slack-task
description: Schedule agent work later or repeatedly, and manage existing tasks through the Codex Slack bridge. Ordinary visible runs create new Slack threads. Use schedule-slack-monitor for deterministic wait-until conditions and one-time follow-ups in an existing thread. Excludes merely scheduling a Slack message or calendar event and executing an already-triggered occurrence.
---

# Schedule Codex tasks with Slack follow-up

Use `codex-slack-schedule` when its launcher is installed, or `node <bridge-checkout>/bin/codex-slack-schedule.mjs` from the operator’s Codex Slack checkout. Locate that checkout from the current workspace or the `codex-slack.service` working directory; do not assume another user’s home path. Run `--help` for the command reference. The documented Linux daemon is `codex-slack.service` (user systemd service).

## Choose the scheduling branch

Ordinary tasks create a fresh agent session whenever they fire. **Every visible run creates a new Slack thread** by default; a recurring task that reports the same blocker can spam new threads. `verbosity:"quiet"` suppresses only exact no-op results, not repeated blocker summaries. Do not use recurring agent work for a deterministic monitor.

For “wait until checks pass,” “notify me when approved,” or another executable readiness condition, use [schedule-slack-monitor](../schedule-slack-monitor/SKILL.md). It uses this same scheduler with `condition` (exit `0` fires, `1` waits without a model) and `thread` (the existing session to follow up in). Conditional tasks disarm after firing unless `repeat:true` is explicitly requested. The monitor skill covers predicate authoring, deadlines, silent failures, and authorization.

For ordinary time-based work that should continue an existing conversation, `thread:"current"` resolves `CODEX_THREAD_ID`; an explicit `thread` or CLI `--session` accepts a saved agent session ID or a linked Slack thread root timestamp. The task channel and exact directory must match that session. This branch queues the prompt into the original inbox and uses the conversation's normal permissions and delivery; it creates no fresh session or Slack root. Omit `thread` when separate conversations are intended.

## Inspect existing tasks

Codex can inspect the live scheduler directly: `codex-slack-schedule status`, `list`, `get <id>`, and `history [id]`. `list` includes every saved task in this daemon, its `cwd`, enabled state, verbosity, Slack destination, and next run. Match `cwd` when the user asks about one project. History includes quiet no-op runs that were not posted to Slack. These commands are read-only and start no task.

## Save the user's task

1. Run `status` and `list` to discover the live folder/channel bindings and existing schedules. Use the requested project folder, or the current project when clear. Preserve the requester's explicit timing and timezone; use the operator’s local timezone from `status` when unspecified, and state any chosen day/time in the response.
2. Write a complete JSON task file using a file-writing tool, then call `put --file /absolute/path/task.json`. Use a stable descriptive `id` so retries update the same task. `put` replaces the full definition; read `get <id>` before modifying an existing task. Never embed unescaped prompts into a shell command.
3. Verify the returned definition or `get <id>`. Report the task ID, next run in the user's timezone, project folder, and Slack destination (or local-only results). Saving does not execute the task immediately. Do not run a live test occurrence unless the user requested one.

Example definition (adapt the prompt and timing to the actual request):

```json
{
  "id": "weekly-log-check",
  "name": "Weekly log check",
  "cwd": "/absolute/project/path",
  "cron": "0 9 * * 1",
  "timezone": "America/Los_Angeles",
  "channel": "auto",
  "prompt": "Check this project's logs for bugs from the last week. Fix clear bugs, verify the fixes, commit and deploy them. If the cause or correct fix is unclear, ask me in this run's Slack thread. Summarize what was found, changed, tested, committed and deployed, and anything still needing my judgment."
}
```

The saved prompt is the instruction for a fresh session: include the needed log locations, environment, and relevant decisions from the conversation. Preserve the actions the user actually authorized. An example authorizing deployment is not blanket permission for every scheduled task. Existing Codex permissions and project instructions still apply.

Recurring tasks use five-field cron (`minute hour day month weekday`) plus an IANA timezone. One-shot tasks use `"at":"2026-10-01T09:00:00-07:00"` instead of `cron`; always include an explicit offset or `Z`. `enabled:false` saves a paused task. If the daemon has multiple authorized Slack users, set `user` to the requester's verified Slack member ID; the originating session can usually supply it automatically.

## Slack routing and runtime behavior

The fresh-session delivery details below apply when `thread` is omitted. Existing-thread follow-ups use normal conversation delivery instead of scheduled quiet/verbose output handling.

- `channel:"auto"` (the default) chooses the closest linked parent directory, preferring an exact project binding. Inspect the returned destination. Use `channel:null` only when the user wants local-only output; no matching linked folder also saves locally. Do not invent channel IDs or send results to an unrelated channel.
- The destination is pinned when saving. A changed folder/channel mapping disables the task on its next attempt until updated; it does not silently send project output to a new channel.
- The daemon's persistent timer handles scheduling. Do not also add cron entries, Codex app automations, or a second Slack-output wrapper. No daemon restart is needed when managing tasks.
- `verbosity:"quiet"` is the default, including older tasks with no setting. Quiet runs create no start/progress messages and suppress successful final answers that are empty or exactly `[SILENT]` after trimming whitespace. Other final results, errors, interruptions, questions, and approvals remain visible. The first useful result or interaction creates a fresh Slack thread bound to the actual session. History always retains the run and final output.
- Use `verbosity:"verbose"` when the user wants starts, progress, and no-op results. To change it, read `get <id>`, preserve the full task definition, change `verbosity`, and call `put`. Human replies in existing run threads remain normal conversations.
- Unless `thread` is set, each visible linked run uses a fresh Slack thread bound to its actual Codex session. The bridge delivers output, questions, and approvals; replies continue that session. Do not separately send the same summary through a Slack connector.
- `history [task-id]` returns the latest 30 runs, session IDs, final output, and failures, including local-only results. Local-only runs needing judgment finish with a question for inspection in history.
- The daemon must be running. After downtime, an overdue task runs once, without replaying every missed occurrence. A restart before agent-session creation is safely recorded as interrupted and does not block later work. Active work or an uncertain run whose agent session may have received the prompt blocks overlapping scheduled work in the same or nested folder. Recurring occurrences are skipped while busy; one-shot tasks remain due.

## Manage or recover

Use `get`, `pause`, `resume`, `remove`, and `history` with the saved task ID. `run <id>` starts an immediate occurrence without changing the timer; use it only when immediate execution is requested. Pause/remove affect future occurrences; use the run's Slack `!stop` to interrupt active work.

If a command times out or delivery is uncertain, inspect `list` and `history` before retrying. Never replay work merely to recover a missing Slack reply. After inspecting the saved session and checking whether changes or deployments already happened, `resolve <run-id> --note "what was verified"` releases an uncertain run's overlap block. Do not resolve unseen work just to get the timer moving.

If `status` cannot connect, inspect `systemctl --user status codex-slack --no-pager`. A sandbox denial connecting to the private Unix socket is a tool execution restriction, not evidence that the daemon is down; use the normal escalation mechanism for the same command. `CODEX_SLACK_STATE_DIR` or `--state-dir` supports a nondefault daemon state directory. Do not inspect or copy Slack tokens to create tasks.
