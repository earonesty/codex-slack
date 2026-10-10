---
name: schedule-slack-monitor
description: Wait for an executable condition, then follow up once in an existing Slack thread using the Codex Slack scheduler. Use for deterministic monitors such as waiting for a review, checks, a deployment, a file, or an external readiness signal. Use schedule-slack-task for scheduled work that requires an agent on every occurrence.
---

# Schedule a deterministic Slack monitor

Use the bridge's existing scheduler with two optional fields: `condition` determines whether a task fires; `thread` selects an existing conversation. Polls run an executable directly, without a model or Slack messages. Exit `0` fires; exit `1` means pending. Other exits, signals, launch failures, or timeouts save `conditionError` for inspection with `get`/`list`. Recurring schedules retry at their next cron occurrence by default; set `disableOnFailure:true` when a monitor must fail closed. One-shot schedules fail closed by default; set `disableOnFailure:false` to retry at `condition.pollSeconds` until expiration. Expiration and authorization/routing failures always disable. Command stdout/stderr are discarded. A failed or expired monitor does not wake an agent or post an alert; tell the user this when saving.

Use [schedule-slack-task](../schedule-slack-task/SKILL.md) for the scheduler's save/read/pause/remove mechanics and ordinary scheduled agent work. That branch creates a fresh agent session on every firing and a **new Slack thread for every visible run**. Do not implement a deterministic monitor by telling a recurring agent to check and return `[SILENT]`.

## Prepare the condition and follow-up

Use `codex-slack-schedule` when installed, or `node <bridge-checkout>/bin/codex-slack-schedule.mjs` from the operator’s checkout, located as described in the task skill. Inspect `status`, `list`, and any existing definition before saving. Use `thread:"current"` when invoked from the intended Slack-linked session (`CODEX_THREAD_ID`), or an explicit saved agent session ID or Slack thread root timestamp with `thread` or `--session`. A timestamp must refer to a conversation already linked to an agent session in the selected channel. The bridge resolves and pins the original Slack conversation; its channel and exact directory must match the task. Without a saved Slack session, obtain the intended session before scheduling; never silently omit `thread` and create new threads.

Write a predicate or use an existing executable that checks exactly the requested condition. Set `condition.executable` to an absolute path and `condition.args` to a JSON string array; there is no implicit shell. Checks run as the daemon's OS user, with its environment and credentials, outside the agent sandbox. Keep predicates read-only and safe to repeat. Do not run repository-contributed code merely to inspect its review or CI status. Wrappers should map verified not-ready states to `1`, and failures to `2` or another nonzero code, rather than treating API/auth/parsing failures as normal waiting. Do not put secrets in arguments, task files, or output.

Test a newly written predicate with representative ready, pending, and failure fixtures. Avoid a live firing just to test delivery; `run <id>` can trigger the real saved follow-up. For a review monitor, match an actual approval to the current head and account for effective changes-requested reviews and unresolved blockers. A successful API read or green status alone is not approval.

The prompt describes the user's authorized follow-up after readiness, such as “tell me it is ready” or an already authorized action. Exit `0` does not grant permission to merge, deploy, pay, or write elsewhere. Have the follow-up re-read relevant external state before a write. Preserve the user's existing authorization.

## Save one conditional task

Example: wait for a local readiness marker and reply once in this conversation.

```json
{
  "id": "wait-for-ready",
  "name": "Wait for the readiness marker",
  "cwd": "/absolute/project/path",
  "cron": "*/5 * * * *",
  "timezone": "America/Los_Angeles",
  "thread": "current",
  "condition": {
    "executable": "/usr/bin/test",
    "args": ["-f", "/absolute/project/path/ready.flag"],
    "timeoutSeconds": 10
  },
  "repeat": false,
  "prompt": "The requested readiness marker appeared. Verify it and tell me in this thread."
}
```

Save the complete definition to a file, call `put --file /absolute/path/task.json`, and verify `get <id>`. Do not create a second timer, standalone Slack sender, or recurring agent task. If saving hits the private control-socket sandbox restriction, use the usual tool escalation for that command; do not inspect Slack tokens.

- With `cron`, its cadence controls predicate checks. With a one-shot `at`, checks begin then and pending checks retry every `condition.pollSeconds` (default 300, minimum 15).
- `condition.timeoutSeconds` defaults to 30 and accepts 1–60. `condition.expiresAt` defaults to seven days after creation; use an ISO timestamp with timezone for a different waiting horizon. It is a deadline for the condition, not an instruction to alert on expiration.
- Conditional tasks default to `repeat:false`: the first passing condition disarms the schedule and queues one follow-up. Leave this default for “wait until” requests. Use `repeat:true` only when repeated execution is explicitly wanted; a condition that remains true will fire again at each due occurrence.
- `thread` queues the saved prompt into the original durable inbox and resumes that conversation. No new root message or agent session is created. Active work delays firing; the bridge does not steer an already running turn. In-thread follow-ups use the conversation's normal delivery and interactive permissions; `verbosity` controls fresh-session scheduled runs, not these conversation replies.
- `history` records the follow-up as queued, which does not prove its agent turn completed. The durable input ID prevents replay after restart. Inspect the original thread with `!status` if delivery is uncertain.
- `pause`/`remove` stop future checks and cancel an in-flight predicate. They do not stop a follow-up already queued. Use that conversation's `!stop` for active agent work. An identical `put` preserves a disarmed schedule; explicitly `resume`, `run`, or save an enabled definition only when rearming is intended.

Report the saved task ID, check cadence, deadline, original thread destination, and one-time trigger behavior. State that pending checks stay silent and failures/expiration are available through `get`/`list`. Creating a monitor does not require a daemon restart after the feature is installed.
