# Why build this bridge?

Recovered from the original September 12–13, 2026 build conversation, reviewed again September 14. These are historical design findings, not a claim that competing projects still have the same implementation. The original review inspected three repositories and ran the TypeScript alternative's tests/build; it did not connect the alternatives to live Slack or model sessions.

| Project reviewed | What informed the decision then |
| --- | --- |
| [BHSDuncan/codex-slack-bridge](https://github.com/BHSDuncan/codex-slack-bridge) | Closest TypeScript starting point; native app-server integration, persistent threads and approvals. The review found session-index rewriting and transcript-file coupling, no RPC timeout, unsupported questions, and slash-command session creation with one default directory. Its 36 tests and build passed. |
| [panzhang83/codex-slack](https://github.com/panzhang83/codex-slack) | Already supported questions, steering and interruption. The concern was complexity and reliance on private SDK helpers, request-handler replacement and private transport access. |
| [SergioTCG/SlackAgentBridge](https://github.com/SergioTCG/SlackAgentBridge) | Broader scope: multiple providers, teams, scheduling, node coordination and terminal management. Codex input used tmux, with terminal-output matching for some failure detection. More machinery than this workflow needed. |

Historical source pointers: [session index](https://github.com/BHSDuncan/codex-slack-bridge/blob/main/src/codex/sessionIndex.ts), [TypeScript adapter](https://github.com/BHSDuncan/codex-slack-bridge/blob/main/src/codex/appServerAdapter.ts), [Python runtime](https://github.com/panzhang83/codex-slack/blob/main/app_runtime.py), [terminal handling](https://github.com/SergioTCG/SlackAgentBridge/blob/main/daemon/codex-terminal.mjs). These links follow upstream main and are not immutable snapshots. Avoid presenting the historical line counts or implementation findings as a current benchmark.

The durable argument is the combination of direct channel-to-directory routing, native thread control, supported protocol calls, and independent bridge state. Steering, scheduling, self-hosting and MIT licensing are features to describe, not claims of uniqueness.

## Claims grounded in this checkout

- **Interruption:** `Codex.interrupt` issues `turn/interrupt` with the active turn ID. This requests interruption; it does not guarantee rollback or immediate cancellation of every running tool.
- **Speed:** the bridge avoids a routing-model round trip and keeps an app-server process. No comparative latency benchmark has been run. Say "direct routing," not "faster than other bridges."
- **Scheduling:** persistent cron/timezones and one-shot runs, quiet output, history, overlap checks, and conservative handling of uncertain dispatch. Requires the daemon/machine to be running; overdue recurring work catches up once. It is not an exactly-once execution guarantee.
- **Permissions:** ordinary sessions inherit Codex configuration. Scheduled sessions explicitly set `danger-full-access` and `approvalPolicy: never`. The current scheduler does not offer configurable per-job sandbox/network/approval policy; the original draft's blanket configurability claim would be misleading.
- **Memory:** the bridge adds no separate routing agent or memory system. Codex manages memory; `cwd` is project context, not guaranteed memory isolation. Describe the Hermes experience as personal experience, not a verified diagnosis of Hermes generally.
- **Ownership/license:** self-hosted daemon, user-owned Slack app, explicit allowlist, MIT project license. Dependencies retain their own licenses.
- **Testing:** offline integration and unit coverage with actual SQLite, JSON-RPC subprocesses, and a local control socket, plus fake Slack delivery. No live Slack/model end-to-end validation or speed benchmark was performed for this testing pass.

## Regression work for the Reddit preparation

Added tests for fragmented Unicode RPC replies, malformed JSON, subprocess exit with multiple pending requests, explicit shutdown, independent interruption across Slack threads, continuation after stop, idle commands without model startup, and simultaneous scheduled runs in sibling directories. Extended the busy-project one-shot test to verify it executes exactly once after the blocker clears.

Run `npm run check`, `npm test`, and `npm run build`. The subprocess/socket tests need an environment that permits child processes and local Unix sockets; the restricted agent sandbox produced failures that disappeared in the normal execution environment.
