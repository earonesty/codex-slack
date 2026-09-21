# Codex Slack

A small, self-hosted Slack bridge to **native Codex app-server sessions**.

- **Channel = project directory.** Bind `#controller` to `~/work` and project channels to their folders.
- **Slack thread = Codex session.** A top-level message creates a session. Replies continue it, or steer its active turn.
- Codex's completed assistant messages (including progress) appear in the same Slack thread.
- Approvals have buttons. Codex questions have answer forms. `!stop` interrupts a turn; `!status` shows the session and latest answer. `/threads` discovers saved Codex threads and `/thread` connects one to Slack.
- Slack shows “Codex is working…” during a turn, including between progress replies. The indicator refreshes every minute and clears on completion, interruption, disconnect, or shutdown. It uses the existing `chat:write` scope; no app reinstall is needed. Status API failures are logged without blocking replies.

No routing model, terminal scraping, private SDK imports, or edits to Codex's session files. The bridge uses [Codex's public app-server protocol](https://developers.openai.com/codex/app-server), Slack Bolt, and Node's built-in SQLite. Codex manages its own history, model, skills, instructions, permissions, and memories.

## Requirements

- Node **24.14+** (uses built-in SQLite and TypeScript transformation for tests).
- Codex CLI installed and logged in on this machine. Protocol baseline: **0.154.0**.
- A Slack workspace where you can install a custom app.
- An always-on machine for the daemon. Linux/systemd is the documented deployment.

## Setup

```sh
git clone https://github.com/earonesty/codex-slack.git
cd codex-slack
npm ci --ignore-scripts
npm run build
cp .env.example .env
```

1. Create a Slack app **from a manifest** using the complete JSON in [Slack app manifest](#slack-app-manifest--paste-into-slack) below, then install it in your workspace.
2. Add **both** tokens to `.env`: the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions → Install to Workspace** goes in `SLACK_BOT_TOKEN`. An **App-Level Token** (`xapp-…`) from **Basic Information → App-Level Tokens**, with `connections:write`, goes in `SLACK_APP_TOKEN`. The bot token discovers your workspace and sends replies; the app token connects Socket Mode. Neither can replace the other. No public HTTP endpoint is needed.
3. Invite the bot to your project channels in Slack. The app listens to ordinary human messages, without requiring an @mention. Use dedicated channels.
4. Run **`npm run setup`**. It discovers your workspace, lets you choose yourself, and writes `config.json`. Channel selection is optional: skip it to choose directories in Slack instead. All folders must already exist. No Slack IDs to find or copy.
5. Run `npm run doctor` to check Slack access, channel membership, folders, and Codex login without starting a model turn. Then `npm start`.

Already installed an earlier version? Apply the updated manifest under **Slack → App Manifest**, then **reinstall the app** under OAuth & Permissions to grant the scopes listed below, including `files:read` for attachments and `channels:join` for joining public channels. The read scopes let setup resolve readable names; no email permission is requested. Keep your existing `.env`.

### Slack app manifest — paste into Slack

In Slack's **Create New App → From a manifest** flow, choose your workspace and the **JSON** tab, then paste this entire block, including the outer braces. This is the contents of [`slack-manifest.json`](slack-manifest.json) ([raw JSON](https://raw.githubusercontent.com/earonesty/codex-slack/main/slack-manifest.json)).

```json
{
  "display_information": { "name": "Codex Slack", "description": "Direct access to local Codex sessions", "background_color": "#202123" },
  "features": {
    "bot_user": { "display_name": "Codex", "always_online": false },
    "slash_commands": [
      { "command": "/threads", "description": "List Codex threads for a configured project", "usage_hint": "[project]", "should_escape": false },
      { "command": "/thread", "description": "Connect Slack to an existing Codex thread", "usage_hint": "<project-name-or-UUID>", "should_escape": false }
    ]
  },
  "oauth_config": { "scopes": { "bot": ["files:read", "channels:history", "channels:join", "channels:read", "chat:write", "groups:history", "groups:read", "users:read"] } },
  "settings": {
    "event_subscriptions": { "bot_events": ["message.channels", "message.groups", "member_joined_channel"] },
    "interactivity": { "is_enabled": true },
    "socket_mode_enabled": true,
    "org_deploy_enabled": false,
    "token_rotation_enabled": false
  }
}
```

### Local daemon configuration — save as `config.json`

Setup writes this file for you. If you prefer to edit it yourself, use Slack **handles** and **channel names**:

```json
{
  "users": ["@earonesty"],
  "root": "~",
  "channels": {
    "#controller": "~/work",
    "#dirtsignal": "~/work/projects/dirtsignal"
  }
}
```

This is local daemon configuration, **not** the Slack app manifest. Run `npm run discover` to list the actual handles and channel names visible to your bot. Handles come from Slack's account usernames; display names can differ, so the setup picker shows both. The workspace is discovered automatically from the bot token. The bot token identifies the bot, so setup still asks which human is allowed to control it.

The bridge resolves names to IDs internally and saves those bindings in `stateDir/identities.json`. Reusing an old handle or channel name cannot silently transfer control to a different person/channel. A renamed user/channel retains its binding while the configured name stays the same. Old configurations using `teamId`, `allowedUserIds`, and channel IDs still work.

Optional fields: `stateDir` defaults to `~/.local/state/codex-slack`; `codexBin` defaults to `codex`. Set `codexBin` to an absolute executable path if your service cannot find Codex. Arguments and shell commands are not accepted there. `CODEX_SLACK_CONFIG` selects a different config file. Relative paths resolve against the daemon's working directory.

You can also start with just `{"users":["@earonesty"]}` and choose directories in Slack. Invite the running bot to an unbound channel: it asks which directory to use, with a **Choose directory** button. Only configured users can open or submit the dialog; no separate admin role is needed. Enter an existing absolute path or `~/…` on the daemon's machine. The binding is saved in SQLite and survives restarts. Startup also checks already-joined channels for missed invitations. Use `!bind` if a prompt was lost. Messages sent before binding are not replayed into Codex.

`root` is the highest allowed binding directory (default: your home directory). For example, `"root": "/home/erik"` allows that directory and its descendants. Existing folders and symlinks are resolved before checking containment; siblings and symlink escapes are rejected. This is a binding restriction, not a Codex filesystem sandbox.

Each exact directory has one channel owner. The directory picker shows a confirmation naming any channel that will be displaced; nested project bindings are unchanged. Confirming disables the displaced channel's existing threads and queued work, and requests interruption of active work (already-running tools may finish). Those old threads remain disabled even if the channel is later rebound; start a new Slack thread. Saved ownership decisions, including unbindings, override manual config entries across restarts. Duplicate directories in manual configuration are rejected.

Apply the updated Slack manifest to subscribe to `member_joined_channel`, then restart the daemon. New sessions use the channel's directory; non-disabled existing threads retain their original directory only while it remains within the allowed root and is not owned by another channel. Restart after configuration edits. To disable a channel with a saved Slack binding, remove the bot from that channel; removing only its manual config entry does not remove the saved binding.

## Daily use

Write a new message in a configured channel to start work. Reply in that message's Slack thread to continue. Separate top-level messages get independent Codex conversations in the same directory; **they still share the working tree**, so coordinate overlapping edits as you would with two terminals.

| Message | Effect |
| --- | --- |
| Any top-level text | Create a new Codex session and start a turn |
| Any thread reply | Resume the bound session, or steer the current turn |
| `!status` | Show the session ID, directory, status, and latest final answer |
| `!stop` | Interrupt the active turn |
| `!help` | Show commands |
| `/threads` | List saved Codex threads whose working directory exactly matches this channel's project |
| `/threads project-name` | List saved Codex threads for another configured project |
| `/thread UUID` | Create a Slack conversation connected to that exact saved Codex thread |
| `/thread project-name` | Connect the most recently updated Codex thread for that configured project |

Slash commands are invoked from the message composer, not inside a Slack thread. `/thread` posts a new top-level message in the configured channel for the selected thread's working directory; reply under that message to continue the native Codex conversation. A thread already connected to Slack is not rebound—the command returns its existing permalink. Project names accept the configured Slack channel name, the directory basename, or the absolute configured directory. Thread discovery includes interactive CLI, VS Code, exec, app-server, and legacy/unknown sessions, but excludes internal sub-agent threads. Apply the current app manifest before using these commands.

### Attachments

Upload files with a message or send files alone, in either a new conversation or a thread reply. PNG, JPEG, GIF, and WebP images are passed as native Codex image inputs. Documents, PDFs, spreadsheets, code, and other files are downloaded locally and included as paths for Codex to inspect with its tools. The accompanying text stays part of the same instruction, including when steering an active turn.

Existing installations need the **files:read** bot scope: apply the updated `slack-manifest.json` in Slack → App Manifest, reinstall under OAuth & Permissions, and restart the built daemon. Missing access is reported without sending a partial prompt. Messages rejected by an older bridge must be resent.

Downloads are private (0600 files in per-message 0700 directories) under `stateDir/attachments`. They remain available for session follow-ups and restarts. They are not automatically pruned; archive or remove them only when their sessions no longer need them. The bot token is used only to retrieve files from Slack and is never passed to Codex.

## Scheduled Codex work

The daemon includes a persistent timer using five-field cron expressions and IANA timezones, plus one-shot timestamps. A local command creates tasks without starting a model or posting a Slack message. When due, each task starts a native session in its project directory. By default, a fresh Slack thread is created only when there is a result, error, question, or approval to show. Output, questions, approvals, and subsequent replies use the existing bridge.

After `npm run build`, use `node bin/codex-slack-schedule.mjs --help` (or `npm run schedule -- --help`). Install `skills/schedule-slack-task` in your personal Codex skills directory to make natural-language scheduling discoverable. On Erik's machine the installed command is `~/.local/bin/codex-slack-schedule`.

Save a task JSON file:

```json
{
  "id": "weekly-log-check",
  "name": "Weekly log check",
  "cwd": "/absolute/project/path",
  "cron": "0 9 * * 1",
  "timezone": "America/Los_Angeles",
  "channel": "auto",
  "prompt": "Check the past week's logs. Fix clear bugs, verify, commit and deploy the fixes. Ask me about anything unclear. Summarize findings and results."
}
```

```sh
node bin/codex-slack-schedule.mjs status
node bin/codex-slack-schedule.mjs put --file /path/to/task.json
node bin/codex-slack-schedule.mjs get weekly-log-check
node bin/codex-slack-schedule.mjs history weekly-log-check
```

Use `at` with an ISO timestamp including an offset or `Z` instead of `cron` for a one-shot task. `put` creates or replaces the full definition by stable ID. Use `pause`, `resume`, and `remove` to manage future occurrences; `run <id>` explicitly starts an extra occurrence immediately. Pause/remove do not interrupt active work. `verbosity` defaults to `"quiet"`, including existing tasks without this field. Quiet runs do not post starts or progress. A successful final answer containing only `[SILENT]` (ignoring surrounding whitespace), or an empty answer, creates no Slack messages. Other final results, failures, interruptions, questions, and approvals remain visible; human replies in an existing run thread behave normally. Codex is instructed to use `[SILENT]` only when nothing changed, no action was taken, and no error or judgment needs attention. This is an explicit marker, not a guess based on words such as “nothing pending.”

Set `"verbosity":"verbose"` in the task JSON to include run starts, progress, and no-op answers. `list`/`get` show the setting, and `history` retains every run and final answer even when nothing was posted to Slack. Read `get <id>` and save the complete definition with `put` to change verbosity; this does not run the task or move its next occurrence.

The saved prompt defines the user's authorized task; scheduling does not override Codex's permissions or project instructions.

`channel:auto` chooses the closest linked directory, preferring an exact match. The chosen destination is pinned. Changed ownership disables the schedule on its next attempt until the definition is updated. `channel:null`, or no matching linked directory, saves final output locally in `history` without sending to Slack. Interactive local-only work requires inspecting the saved session locally.

Schedules and run history live in `schedules.sqlite` under the existing private state directory. The CLI uses `control.sock` (mode 0600); it does not need Slack credentials. The timer checks every five seconds and requires the daemon/machine to be running. After downtime, each overdue task runs once rather than replaying all missed intervals. Active or uncertain work in the same or nested directory blocks scheduled launches: recurring occurrences are skipped and one-shot tasks wait. Work in separate directories can proceed independently.

Interrupted dispatch is recorded as uncertain and is never automatically replayed. Inspect the saved session, Slack thread, and any changes before using `resolve <run-id> --note "what was verified"` to release that block. `history` returns the latest 30 runs with final output, session IDs, and failures. Existing outbox handling retains uncertain Slack deliveries without blindly duplicating them.

Use `--state-dir` or `CODEX_SLACK_STATE_DIR` when the daemon uses a nondefault state directory. No crontab changes or daemon restart are needed to manage tasks.
| `!bind` | Show the directory picker in an unbound channel |

Commands must be the entire message. Prefix another character if you want to discuss a literal command. Questions and approvals use explicit controls; ordinary replies are always prompts. Closing an answer modal leaves the question pending; use its Cancel button to dismiss it.

Only configured users in the configured workspace/channels can send instructions or answer controls. Anyone in an allowed channel can read its replies; configure Slack membership accordingly. This is a personal/operator bridge, not a multi-tenant service.

## Codex behavior

The daemon spawns one `codex app-server` and communicates over stdio. It initializes the protocol, creates/resumes threads, starts/steers/interrupts turns, and forwards server requests. It does not start another model to interpret Slack commands.

Model, reasoning effort, instructions, and memory settings are inherited from your effective Codex configuration. Scheduled runs explicitly request `sandbox: "danger-full-access"` and `approvalPolicy: "never"`, giving unattended work full filesystem and network access without approval prompts. This applies to existing and newly saved jobs, including manual `run` occurrences; task authorization and project instructions still apply. Ordinary Slack sessions inherit Codex permissions. Directory selection provides project context; it is **not a memory-isolation or filesystem-security boundary**.

Bindings and messages are stored in `stateDir/bridge.sqlite`. SQLite also provides a separate process lease so two daemons cannot use the same state directory. Run only one instance per Slack app token, even with different state directories. The state directory is private to your OS user and contains conversation text; it is not encrypted.

## Delivery and recovery

- Incoming Slack messages are deduplicated by workspace/channel/message timestamp and journaled before Codex dispatch.
- Dispatch is serialized per Slack thread; independent threads can run concurrently. Serialization covers the protocol acknowledgement, not the whole model turn, so follow-ups can steer ongoing work.
- Replies are journaled before Slack delivery and deduplicated by Codex thread/turn/item IDs.
- Unsent queued inputs resume on restart. Inputs interrupted during dispatch are marked uncertain and **never automatically replayed**: they might already have run tools.
- Ambiguous Slack writes are retained as failed/uncertain instead of duplicated. Use `!status` to recover the latest answer. The bridge logs delivery IDs, not message bodies.
- Persisted Codex sessions resume on the next reply. Restarting this stdio daemon interrupts active Codex work; it does not preserve a live process. Pending approval buttons expire on disconnect.

This is not an exactly-once delivery guarantee. Slack Bolt can acknowledge an event before the application journals it, and network loss can make a write's outcome unknowable. Observe the bot's reply and use `!status` if a message appears unacknowledged. There is no automatic history backfill or tool replay.

## Current limits

Version 0.1 is intentionally narrow:

- Up to 10 uploaded files per message, 25 MiB each and 50 MiB total. Remote file links (such as cloud document shares) must be uploaded as actual files. If any attachment fails, the whole prompt is held back with a visible error.
- MCP elicitation forms/URL confirmations are declined visibly. Native Codex `requestUserInput` questions are supported. Secret question fields and oversized approval forms are rejected rather than truncated or silently approved.
- Approval buttons offer one-time decisions, not persistent rule changes. Permission grants last for the current turn. File approval cards include the proposed changes; if that event is missing, only negative decisions are offered.
- No attachment to a currently running terminal process, remote app-server transport, or team orchestration. `/thread` resumes the selected saved conversation through this bridge's app-server connection; it does not take over another live process.
- Outputs are forwarded when each assistant message completes, not token by token. Standard model-generated Markdown is currently displayed as plain text to avoid unintended Slack mentions.
- No scheduled database pruning. Remove or archive the private state directory only when you no longer need its bindings and delivery history.

## Linux service

Copy [`contrib/codex-slack.service`](contrib/codex-slack.service) to `~/.config/systemd/user/codex-slack.service`. Edit the checkout path, Node executable, and PATH. For nvm installations, use the absolute Node executable and set `codexBin` explicitly in config. Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-slack
journalctl --user -u codex-slack -f
```

The service restarts on crashes and stops its whole process group on shutdown. User services normally require a logged-in user; use your system's lingering configuration if you want it to run after logout. Stop the foreground instance before starting the service.

### Restarting from inside a Codex Slack session

The session's command executor is a descendant of the bridge service. A direct
`systemctl --user restart codex-slack.service` kills that executor before it returns,
so the tool can report `aborted` even when systemd successfully restarted the bridge.
This is not an approval rejection. Inspect service start time and health before retrying.

Build and test the intended changes, then use the session-aware helper:

```sh
node bin/codex-slack-restart.mjs
node bin/codex-slack-restart.mjs status
```

The helper defaults to `CODEX_THREAD_ID`; use `--session <Codex thread ID>` when
needed. `--state-dir` and `CODEX_SLACK_STATE_DIR` select a nondefault state directory.
It requires a saved Slack session with an owner and a healthy scheduler with no active
or uncertain scheduled runs. Restarting also interrupts other interactive work in this daemon.

Before requesting a restart, it saves the session ID, pinned Slack binding, owner,
and old systemd invocation ID in the bridge's private `bridge.sqlite` database.
It then installs a five-second user systemd timer outside the bridge's control group,
running `contrib/restart-and-check.mjs`. Once a different daemon invocation has connected
to Codex and Slack and opened its control socket, startup atomically queues one lifecycle
notification into that session's durable inbox. The notification asks Codex to confirm
readiness without repeating the restart or interrupted work. Existing message delivery
rules prevent replay when a Codex acknowledgement is uncertain. The destination and
owner are revalidated; revoked bindings do not receive the notification.

`status` reads the latest handoff: `pending` awaits recovery, `queued` means inserted
into the inbox (not proof of a delivered reply), and `failed` records a routing failure.
Repeated requests while one is pending do not schedule another restart. A late recovery
is explicitly described as delayed rather than evidence of continuous availability.
The independent helper writes `scheduling-restart.log` in the state directory, including
failures if the new daemon never becomes healthy. No success notification is sent if
startup fails before readiness.

If timer creation has an uncertain acknowledgement, leave the handoff pending and inspect
`systemctl --user status codex-slack-restart-<handoff-id>.timer`, the helper log, and the
service journal before taking further action. A later successful service start consumes
the pending handoff. Do not treat the absence of a reply as authorization to replay work.

## Development

```sh
npm run check
npm test
npm run build
```

Tests use a fake JSON-RPC subprocess and fake Slack delivery; no Slack credentials or paid model calls are needed. For protocol updates, inspect the installed CLI's authoritative types with `codex app-server generate-ts --out /tmp/codex-protocol`. Keep bridge state separate from Codex implementation details.

MIT licensed. Independent project; not affiliated with OpenAI or Slack.
