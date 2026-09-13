# Codex Slack

A small, self-hosted Slack bridge to **native Codex app-server sessions**.

- **Channel = project directory.** Bind `#controller` to `~/work` and project channels to their folders.
- **Slack thread = Codex session.** A top-level message creates a session. Replies continue it, or steer its active turn.
- Codex's completed assistant messages (including progress) appear in the same Slack thread.
- Approvals have buttons. Codex questions have answer forms. `!stop` interrupts a turn; `!status` shows the session and latest answer.

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
cp config.example.json config.json
cp .env.example .env
```

1. Create a Slack app **from a manifest** using [`slack-manifest.json`](slack-manifest.json), then install it in your workspace.
2. Under Basic Information → App-Level Tokens, create an app token with `connections:write`. Put it in `.env` as `SLACK_APP_TOKEN` (`xapp-…`). Put the bot token from OAuth & Permissions in `SLACK_BOT_TOKEN` (`xoxb-…`). Socket Mode needs no public HTTP endpoint.
3. Edit `config.json`: set the workspace ID, your Slack member ID, and channel IDs with their local directories. Channel IDs remain stable across renames. All directories must already exist.
4. Invite the bot to those channels. The app listens to ordinary human messages, without requiring an @mention. Use dedicated channels.
5. Run `npm run doctor` to validate folders and the Codex handshake/login without starting a model turn. Then `npm start`.

Example configuration:

```json
{
  "teamId": "T0123456789",
  "allowedUserIds": ["U0123456789"],
  "channels": {
    "C0123456789": { "cwd": "~/work" },
    "C9876543210": { "cwd": "~/work/projects/dirtsignal" }
  },
  "stateDir": "~/.local/state/codex-slack",
  "codexBin": "codex"
}
```

`CODEX_SLACK_CONFIG` selects a different config file. Relative paths resolve against the daemon's working directory. Set `codexBin` to an absolute executable path if your service cannot find Codex. Arguments and shell commands are not accepted there.

New sessions use the channel's configured directory. Existing thread bindings retain their original directory, even if you change the channel configuration. Restart the daemon after configuration edits. Removing a channel disables delivery to it, including queued outputs.

## Daily use

Write a new message in a configured channel to start work. Reply in that message's Slack thread to continue. Separate top-level messages get independent Codex conversations in the same directory; **they still share the working tree**, so coordinate overlapping edits as you would with two terminals.

| Message | Effect |
| --- | --- |
| Any top-level text | Create a new Codex session and start a turn |
| Any thread reply | Resume the bound session, or steer the current turn |
| `!status` | Show the session ID, directory, status, and latest final answer |
| `!stop` | Interrupt the active turn |
| `!help` | Show commands |

Commands must be the entire message. Prefix another character if you want to discuss a literal command. Questions and approvals use explicit controls; ordinary replies are always prompts. Closing an answer modal leaves the question pending; use its Cancel button to dismiss it.

Only configured users in the configured workspace/channels can send instructions or answer controls. Anyone in an allowed channel can read its replies; configure Slack membership accordingly. This is a personal/operator bridge, not a multi-tenant service.

## Codex behavior

The daemon spawns one `codex app-server` and communicates over stdio. It initializes the protocol, creates/resumes threads, starts/steers/interrupts turns, and forwards server requests. It does not start another model to interpret Slack commands.

Model, reasoning effort, approval policy, sandbox, instructions, and memory settings are inherited from your effective Codex configuration. The bridge does not bypass approvals or inject its own system prompt. Directory selection provides project context; it is **not a memory-isolation or filesystem-security boundary**. Configure permissions in Codex itself.

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

- Text only. Attachment messages are rejected visibly, including any accompanying text, so Codex never acts on an incomplete instruction.
- MCP elicitation forms/URL confirmations are declined visibly. Native Codex `requestUserInput` questions are supported. Secret question fields and oversized approval forms are rejected rather than truncated or silently approved.
- Approval buttons offer one-time decisions, not persistent rule changes. Permission grants last for the current turn. File approval cards include the proposed changes; if that event is missing, only negative decisions are offered.
- No attachment to an independently running terminal session, remote app-server transport, slash commands, scheduling, or team orchestration.
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

## Development

```sh
npm run check
npm test
npm run build
```

Tests use a fake JSON-RPC subprocess and fake Slack delivery; no Slack credentials or paid model calls are needed. For protocol updates, inspect the installed CLI's authoritative types with `codex app-server generate-ts --out /tmp/codex-protocol`. Keep bridge state separate from Codex implementation details.

MIT licensed. Independent project; not affiliated with OpenAI or Slack.
