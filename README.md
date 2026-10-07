# Codex Slack

A small, self-hosted Slack bridge to native coding-agent sessions. Codex is the default and has the deepest integration; Claude Code is available through an experimental driver.

- **Channel = project directory.** Bind `#controller` to `~/work` and project channels to their folders.
- **Slack thread = agent session.** A top-level message creates a session. Replies continue it, or steer its active turn.
- Completed assistant messages appear in the same Slack thread.
- Approvals have buttons. Codex questions have answer forms. `!stop` interrupts a turn; `!status` shows the session and latest answer. `!threads` discovers saved project threads and `!thread` connects one to Slack.
- Slack shows “Codex is working…” during a turn, including between progress replies. The indicator refreshes every minute and clears on completion, interruption, disconnect, or shutdown. It uses the existing `chat:write` scope; no app reinstall is needed. Status API failures are logged without blocking replies.

No routing model, terminal scraping, private SDK imports, or edits to Codex's session files. The bridge uses [Codex's public app-server protocol](https://developers.openai.com/codex/app-server), Slack Bolt, and Node's built-in SQLite. Codex manages its own history, model, skills, instructions, permissions, and memories.

## Requirements

- Node **24.14+** (uses built-in SQLite and TypeScript transformation for tests).
- Either Codex CLI (protocol baseline **0.154.0**) or Claude Code CLI installed and logged in on this machine.
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
5. Run `npm run doctor` to check Slack access, channel membership, folders, and the selected agent's login without starting a model turn. Then `npm start`.

Already installed an earlier version? Apply the updated manifest under **Slack → App Manifest**, then **reinstall the app** under OAuth & Permissions to grant the scopes listed below, including `files:read` for attachments and `channels:join` for joining public channels. The read scopes let setup resolve readable names; no email permission is requested. Keep your existing `.env`.

### Slack app manifest — paste into Slack

In Slack's **Create New App → From a manifest** flow, choose your workspace and the **JSON** tab, then paste this entire block, including the outer braces. This is the contents of [`slack-manifest.json`](slack-manifest.json) ([raw JSON](https://raw.githubusercontent.com/earonesty/codex-slack/main/slack-manifest.json)).

```json
{
  "display_information": { "name": "Codex Slack", "description": "Direct access to local Codex sessions", "background_color": "#202123" },
  "features": { "bot_user": { "display_name": "Codex", "always_online": false } },
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

Optional fields: `stateDir` defaults to `~/.local/state/codex-slack`. `scheduledBrowserUse` defaults to `true`; set it to `false` to keep unattended scheduled runs off the Codex Browser Use/CUA connector while leaving interactive conversations unchanged. This flag does not ban browsers or interactive browser sessions: repository-owned CDP, Playwright/Puppeteer, nodriver/Zendriver, and similar automation remain allowed. The agent defaults to `{"driver":"codex","command":"codex"}`. To use Claude Code, add:

```json
"agent": { "driver": "claude", "command": "claude" }
```

Set `command` to an absolute executable path when the service cannot find the CLI. Arguments and shell commands are not accepted. The older `codexBin` setting remains accepted when `agent` is omitted. `CODEX_SLACK_CONFIG` selects a different config file. Relative paths resolve against the daemon's working directory.

### Agent drivers

The Slack, persistence, scheduling, attachment, and recovery layers depend on the normalized interface in `src/agent.ts`, not on either CLI protocol. Drivers translate native lifecycle events into session/turn start, message, completion, interruption, and disconnect events, and advertise optional capabilities instead of making the bridge guess.

The Codex driver retains app-server approvals, questions, saved-thread discovery, and native image inputs. The Claude driver uses Claude Code's documented streaming JSON CLI with resumable session IDs. It supports concurrent sessions, replies/steering, interruption, attachments as local file paths, status during the current daemon lifetime, and scheduled work. Claude's CLI does not currently expose the saved-session metadata this bridge needs for safe project-scoped `!threads`/`!thread`, so those commands report that the capability is unavailable. Permission prompts are not relayed to Slack: ordinary Claude sessions use `auto` mode with prompts disabled, while explicitly scheduled unattended runs use bypass mode, matching the scheduler's existing unattended trust model.

You can also start with just `{"users":["@earonesty"]}` and choose directories in Slack. Invite the running bot to an unbound channel: it asks which directory to use, with a **Choose directory** button. Only configured users can open or submit the dialog; no separate admin role is needed. Enter an existing absolute path or `~/…` on the daemon's machine. The binding is saved in SQLite and survives restarts. Startup also checks already-joined channels for missed invitations. Use `!bind` if a prompt was lost. Messages sent before binding are not replayed into the selected agent.

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
| `!threads` | List saved Codex threads whose working directory exactly matches this channel's project |
| `!thread UUID` | Connect this unbound Slack conversation to that saved Codex thread |

Send `!threads` as a new top-level message to get a project-scoped picker with a **Connect** button for each available thread. The picker and its buttons live in that Slack conversation; choices expire after 24 hours and survive daemon restarts. You can also reply with `!thread UUID` or send it as a new top-level message. Connecting is allowed only while that Slack conversation has no Codex session, the saved thread's working directory exactly matches the channel's project, and the Codex thread is not already connected elsewhere. Thread discovery includes interactive CLI, VS Code, exec, app-server, and legacy/unknown sessions, but excludes internal sub-agent threads.

### Attachments

Upload files with a message or send files alone, in either a new conversation or a thread reply. PNG, JPEG, GIF, and WebP images are passed as native Codex image inputs. Documents, PDFs, spreadsheets, code, and other files are downloaded locally and included as paths for Codex to inspect with its tools. The accompanying text stays part of the same instruction, including when steering an active turn.

Existing installations need the **files:read** bot scope: apply the updated `slack-manifest.json` in Slack → App Manifest, reinstall under OAuth & Permissions, and restart the built daemon. Missing access is reported without sending a partial prompt. Messages rejected by an older bridge must be resent.

Downloads are private (0600 files in per-message 0700 directories) under `stateDir/attachments`. They remain available for session follow-ups and restarts. They are not automatically pruned; archive or remove them only when their sessions no longer need them. The bot token is used only to retrieve files from Slack and is never passed to Codex.

## GitHub maintainer feed

Optionally bind a dedicated Slack channel to an existing workspace directory and add the following configuration. The feed requires the Codex driver because its automatic turns use Codex's enforced read-only sandbox:

```json
"github": {
  "channel": "#github-maintainer",
  "codexHome": "~/.codex-triage",
  "owners": ["your-account", "your-organization"],
  "include": ["your-account/maintained-fork"],
  "exclude": [],
  "excludePullRequestAuthors": ["your-account"],
  "skipTriage": [
    { "author": "^(dependabot|pixeebot)(\\[bot\\])?$" }
  ],
  "intervalSeconds": 300,
  "batchSize": 3
}
```

The bot must already have joined the channel, which must also appear in `channels`.
Install and authenticate `gh` for the daemon's OS user. The feed uses `gh api` with
read-only requests, keeping credentials out of model prompts and bridge state.
Discovery includes public, non-archived, non-fork repositories under `owners` where
the authenticated account has admin or maintain permission. `include` explicitly
adds maintained forks or repositories outside those owners; the same visibility
and permission checks apply. `exclude` always wins. Discovery refreshes hourly.

`excludePullRequestAuthors` excludes PRs by exact, case-insensitive GitHub login
from new cards, card updates, and automatic triage, including already queued backlog.
Issues by those authors are unaffected. Existing Slack cards remain available for
manual replies. Restart after edits.

`skipTriage` accepts case-insensitive JavaScript regex patterns for `author`, `title`,
`repo`, `label`, or `body`. Any matching rule skips the item; all fields within a
rule must match. `label` matches any one of an item's labels. For example,
`{"repo":"^your-org/", "title":"^chore:"}` skips chore titles only in that
organization. Use pattern strings without `/.../` delimiters; JSON backslashes
must be doubled. Invalid regexes or unknown fields fail configuration validation.
Matches suppress only automatic triage, including already queued backlog. Matching
items still get cards and card updates in the feed, marked as skipped for automatic
triage. Reply in any thread to request triage or other work manually. Previously
triaged items are not triaged again when filters change. Restart after edits.

Every five minutes by default, the feed backfills open issues and PRs, then tracks
updated items (including closed ones). [GitHub's issues endpoint includes PRs](https://docs.github.com/en/rest/issues/issues).
Each item has one Slack card/thread; subsequent updates edit the card without
repeating automatic triage. The automatic assessment uses the persisted title,
description, labels, author, state, and update timestamp as its starting context.
It may inspect the bound checkout and use configured read-only diagnostic tools when
that materially improves the assessment. It reports missing evidence or uncertainty.
Reviews/checks that do not change the issue's `updated_at` are not standalone feed
events.

New cards start transient Codex sessions through the existing durable inbox with
`sandbox:"read-only"` and `approvalPolicy:"never"` enforced. The model receives the
persisted item snapshot and may perform read-only diagnosis with the checkout and
tools available to that Codex installation. It is instructed not to use tools that
create, update, delete, or send data outside the configured Slack conversation.
The restricted session is used only for that automatic turn and is never attached
as the Slack conversation's resumable session. Public GitHub data remains untrusted
input. A later human reply starts an ordinary session with the item's URL and context;
it follows the operator's normal Codex policy.
Posting GitHub replies, changing labels, closing, pushing, creating PRs, or merging
still requires that explicit operator instruction. Reply naturally, for example
“draft a response,” “post that response,” “close as duplicate of #12,” or “fix it
and open a PR.” Existing operator authorization, interactive approvals, `!stop`,
`!status`, and restart recovery apply.

### Automatic-triage trust boundary

Codex Slack is a personal/operator bridge, not a multi-tenant service. Automatic
triage deliberately trades isolation for useful diagnosis: public GitHub content can
cause Codex to read the bound project and invoke the diagnostic tools enabled in its
effective configuration. The configured Slack channel is the reporting boundary.
Treat every member who can read that channel, the bound workspace, and every tool or
MCP server exposed to Codex as mutually trusted for this project.

The enforced read-only sandbox prevents workspace modification, and `never` prevents
the automatic turn from stopping to request broader approval. Those settings do not
turn off tools or make a write-capable connector read-only. Do not expose automatically
approved mutating tools or credentials to this workload unless that access is part of
your intended trust boundary. `skipTriage` can suppress automatic investigation for
repositories, authors, or content that should require a human instruction first.

For stronger separation, set `github.codexHome` to an existing dedicated Codex home
that contains only the skills, MCP servers, apps, credentials, and diagnostic tools
intended for automatic triage. The bridge starts a second Codex app-server with that
`CODEX_HOME`; automatic feed turns use it, while human replies and all other Slack work
continue through the ordinary Codex installation. The two processes share the bound
project directory, but the triage process does not load user-level configuration,
session history, home-level skills, apps, or MCP connections from the ordinary home.
Project-local instructions and `.codex` configuration in the bound checkout still
apply to both processes.

Create and authenticate the home before starting the daemon, then add only the tools
you intend to trust with public issue and pull-request content:

```sh
mkdir -p ~/.codex-triage
CODEX_HOME=~/.codex-triage codex login
```

An empty triage `config.toml` still provides local read-only checkout inspection and
the persisted GitHub snapshot supplied by the feed. Add narrowly scoped read-only
GitHub or diagnostic tools there only when they improve triage. `npm run doctor`
checks authentication for both Codex homes. Restart after changing `codexHome` or its
tool configuration.

`batchSize` (1–10, default 3) limits new assessments per polling cycle and pauses
launches while that many agent turns are active; backlog drains gradually. Feed
state and per-repository cursors persist in `stateDir/github.sqlite`. Failed reads
retain their cursor. Unacknowledged Slack posts remain `uncertain` and are never
automatically reposted; inspect the service journal and channel before manually
resolving them. Failed/ambiguous card edits are logged and wait for a newer GitHub
update. Restart after changing the configuration.

## Scheduled Codex work

Schedules accept an optional executable `condition` and an optional existing
`thread`. Use both for deterministic “wait until ready, then follow up here”
monitors. Without `thread`, every visible scheduled run creates a new Slack thread.
Quiet mode alone does not prevent a recurring agent from posting the same blocker
on every occurrence. See [the monitor skill](skills/schedule-slack-monitor/SKILL.md)
and [the ordinary task skill](skills/schedule-slack-task/SKILL.md).

```json
{
  "id": "wait-for-ready",
  "name": "Wait for readiness",
  "cwd": "/absolute/project/path",
  "cron": "*/5 * * * *",
  "timezone": "America/Los_Angeles",
  "thread": "current",
  "condition": {
    "executable": "/absolute/path/check-ready",
    "args": [],
    "timeoutSeconds": 30
  },
  "repeat": false,
  "prompt": "Verify readiness and tell me in this conversation."
}
```

Save with the same `put --file` command as ordinary tasks. `thread:"current"`
resolves `CODEX_THREAD_ID`; an explicit `thread` or CLI `--session` accepts an
existing agent session ID or the Slack thread's root timestamp in the selected
channel. The task directory must exactly match the saved session. The destination
is pinned and revalidated before delivery. The follow-up goes through that
conversation's durable inbox and normal interactive permissions, without creating
a new session or Slack root. Its history entry records **queued**, not proof that
the resulting agent turn finished; use `!status` in the original thread to inspect
it. Existing active work delays firing rather than being steered by a timer.

The predicate runs directly, with argv and no implicit shell, as the daemon's OS
user in the task directory. It has the daemon's environment and is outside the
agent sandbox; use read-only checks safe to repeat. No model runs on pending checks,
and command output is discarded. Exit **0** fires, **1** waits, and other exit
codes, signals, timeouts, or launch failures disable the schedule with
`conditionError` visible in `get`/`list`. These failures and expiration do not post
Slack alerts. `conditionLastChecked` and `conditionLastExit` expose check state.
The timeout accepts 1–60 seconds. A cron schedule sets check cadence; an `at`
schedule retries pending checks every `condition.pollSeconds` (default 300).
`condition.expiresAt` accepts an ISO timestamp with timezone and defaults to seven
days after creation. No missed checks are replayed after downtime.

Conditional tasks disarm on their first firing unless `repeat:true` explicitly
allows repeated firing while the condition remains true. A `thread` without a
condition also works for ordinary time-based follow-ups. Pause/remove cancel an
in-flight predicate, but do not cancel an already queued follow-up. A stable
durable input ID prevents replay across a crash between claiming a firing and
queuing its follow-up. Readiness never expands the saved prompt's authorization;
re-read current external state before taking an authorized action.

The daemon includes a persistent timer using five-field cron expressions and IANA timezones, plus one-shot timestamps. A local command creates tasks without starting a model or posting a Slack message. When due, each task starts a native session in its project directory. By default, a fresh Slack thread is created only when there is a result, error, question, or approval to show. Output, questions, approvals, and subsequent replies use the existing bridge.

After `npm run build`, use `node bin/codex-slack-schedule.mjs --help` (or `npm run schedule -- --help`). Install both `skills/schedule-slack-task` and `skills/schedule-slack-monitor` in your personal Codex skills directory, preserving their folder names, to make both scheduling branches discoverable. On Erik's machine the installed command is `~/.local/bin/codex-slack-schedule`.

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

When `"scheduledBrowserUse": false` is set in `config.json`, unattended occurrences are instructed not to use the Codex Browser Use connector, browser-control/CUA, or connector file downloads. The flag selects whether that connector is available; it does not mean “no browser,” “headless only,” or “no interactive browser automation.” Interactive or headless sessions driven through repository-owned CDP, Playwright/Puppeteer, nodriver/Zendriver, and similar tooling remain allowed, as do direct HTTP and repository-owned scripts. If an active scheduled turn nevertheless requests Codex Browser Use approval, the bridge declines it without opening a Slack approval thread. The daemon default is `true`; restart it after changing the setting. A task can override the daemon default with `"scheduledBrowserUse": true` or `false` in its schedule JSON, so a task that specifically requires the Codex connector can enable it while other unattended work is guarded. Unrelated approvals and later human follow-ups remain interactive in either mode.

Set `"verbosity":"verbose"` in the task JSON to include run starts, progress, and no-op answers. `list`/`get` show the setting, and `history` retains every run and final answer even when nothing was posted to Slack. Read `get <id>` and save the complete definition with `put` to change verbosity; this does not run the task or move its next occurrence.

The saved prompt defines the user's authorized task; scheduling does not override Codex's permissions or project instructions.

Codex jobs inherit the machine's effective permissions by default, including `approvals_reviewer`. To explicitly override a particular job, add `"codexPermissions":{"sandbox":"read-only","approvalPolicy":"on-request"}` to its JSON. Either field may be omitted to inherit its default. Sandbox accepts `read-only`, `workspace-write`, or `danger-full-access`; approval policy accepts `on-request` or `never`. Overrides apply to new Codex sessions and their later replies/resumes, including after a daemon restart. They are saved with the run, so changing a job affects future occurrences. Existing-thread follow-ups and Claude jobs reject this Codex-specific field.

`channel:auto` chooses the closest linked directory, preferring an exact match. The chosen destination is pinned. Changed ownership disables the schedule on its next attempt until the definition is updated. `channel:null`, or no matching linked directory, saves final output locally in `history` without sending to Slack. Interactive local-only work requires inspecting the saved session locally.

Schedules and run history live in `schedules.sqlite` under the existing private state directory. The CLI uses `control.sock` (mode 0600); it does not need Slack credentials. The timer checks every five seconds and requires the daemon/machine to be running. After downtime, each overdue task runs once rather than replaying all missed intervals. Active or uncertain work in the same or nested directory blocks scheduled launches: recurring occurrences are skipped and one-shot tasks wait. Work in separate directories can proceed independently.

If the bridge stops before an agent session is created, recovery records the occurrence as interrupted and leaves future runs unblocked because no task prompt could have been dispatched. An interrupted dispatch after session creation is recorded as uncertain and is never automatically replayed. Inspect the saved session, Slack thread, and any changes before using `resolve <run-id> --note "what was verified"` to release that block. `history` returns the latest 30 runs with final output, session IDs, and failures. Existing outbox handling retains uncertain Slack deliveries without blindly duplicating them.

Use `--state-dir` or `CODEX_SLACK_STATE_DIR` when the daemon uses a nondefault state directory. No crontab changes or daemon restart are needed to manage tasks.
| `!bind` | Show the directory picker in an unbound channel |

Commands must be the entire message. Prefix another character if you want to discuss a literal command. Questions and approvals use explicit controls; ordinary replies are always prompts. Closing an answer modal leaves the question pending; use its Cancel button to dismiss it.

Only configured users in the configured workspace/channels can send instructions or answer controls. Anyone in an allowed channel can read its replies; configure Slack membership accordingly. This is a personal/operator bridge, not a multi-tenant service.

## Agent behavior

With the default driver, the daemon spawns `codex app-server` and communicates over stdio. After all turns have been idle for a minute, it recycles that process and its helper process group; the next input transparently resumes the saved session through a fresh app-server. This bounds resources left by completed tool calls. The Claude driver starts a streaming `claude -p` subprocess for each live session and resumes its native session ID after a process or daemon restart. Neither driver starts another model to interpret Slack commands.

Model, reasoning effort, instructions, and memory settings are inherited from the selected agent's effective configuration. Codex scheduled runs inherit the machine's effective sandbox, approval policy, and approval reviewer configuration, just like ordinary sessions. The scheduler does not override these settings on creation or resume, including manual `run` occurrences. Claude scheduled runs use `bypassPermissions`. Task authorization and project instructions still apply. Directory selection provides project context; it is **not a memory-isolation or filesystem-security boundary**.

Bindings and messages are stored in `stateDir/bridge.sqlite`. SQLite also provides a separate process lease so two daemons cannot use the same state directory. Run only one instance per Slack app token, even with different state directories. The state directory is private to your OS user and contains conversation text; it is not encrypted.

## Delivery and recovery

- Incoming Slack messages are deduplicated by workspace/channel/message timestamp and journaled before Codex dispatch.
- Socket Mode URL discovery retries transient network failures independently from outbound message delivery. Heartbeat timeouts reconnect automatically; outbound Slack writes remain single-attempt because retrying an ambiguous write can duplicate a reply.
- Dispatch is serialized per Slack thread; independent threads can run concurrently. Serialization covers the protocol acknowledgement, not the whole model turn, so follow-ups can steer ongoing work.
- Replies are journaled before Slack delivery and deduplicated by Codex thread/turn/item IDs.
- Unsent queued inputs resume on restart. Inputs interrupted during dispatch are marked uncertain and **never automatically replayed**: they might already have run tools.
- Ambiguous Slack writes are retained as failed/uncertain instead of duplicated. Use `!status` to recover the latest answer. The bridge logs delivery IDs, not message bodies.
- Persisted Codex sessions resume on the next reply. Restarting this stdio daemon interrupts active Codex work; it does not preserve a live process. Pending approval buttons expire on disconnect.

This is not an exactly-once delivery guarantee. Slack Bolt can acknowledge an event before the application journals it, and network loss can make a write's outcome unknowable. Observe the bot's reply and use `!status` if a message appears unacknowledged. There is no automatic history backfill or tool replay.

## Current limits

Version 0.1 is intentionally narrow:

- Up to 10 uploaded files per message, 25 MiB each and 50 MiB total. Remote file links (such as cloud document shares) must be uploaded as actual files. If any attachment fails, the whole prompt is held back with a visible error.
- MCP URL confirmations and empty forms wait for a real Approve/Decline/Cancel decision. Simple forms accept validated JSON input through Slack; secret or unsupported forms require a native client and are reported as unsupported, never as a user denial. Native Codex `requestUserInput` questions are supported. Secret question fields and oversized approval forms are rejected rather than truncated or silently approved.
- Approval buttons offer one-time decisions, not persistent rule changes. Permission grants last for the current turn. File approval cards include the proposed changes; if that event is missing, only negative decisions are offered.
- No attachment to a currently running terminal process, remote app-server transport, slash commands, or team orchestration. `!thread` resumes the selected saved conversation through this bridge's app-server connection; it does not take over another live process.
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
