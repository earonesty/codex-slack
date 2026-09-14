# Operating the Slack bridge

Read README.md before changing daemon lifecycle or session delivery.

## Restarting from a Slack-linked Codex session

This chat's Codex app-server and shell tools can be children of `codex-slack.service`.
`systemctl --user restart codex-slack.service` kills the command executor as well as
the bridge. A tool result of `aborted` is therefore ambiguous: the restart may have
succeeded. It is not evidence of an approval rejection. Do not repeatedly restart.

After building and testing an authorized change, use:

```sh
node /home/erik/work/projects/codex-slack/bin/codex-slack-restart.mjs
```

The helper uses `CODEX_THREAD_ID` (or `--session <id>`), saves a durable handoff,
and schedules an independent systemd restart. New daemon startup sends a readiness
notice into the original Codex session through the bridge inbox. It does not replay
the interrupted task. Use the normal execution escalation mechanism if the sandbox
blocks systemd or the private control socket; prior user restart authorization is enough.

If the result is interrupted or uncertain, inspect instead of repeating the mutation:

```sh
node /home/erik/work/projects/codex-slack/bin/codex-slack-restart.mjs status
systemctl --user show codex-slack.service -p ActiveState -p InvocationID -p ExecMainStartTimestamp
```

`queued` means the readiness notice entered the durable inbox, not that its model
reply was delivered. See README.md for failure recovery and the independent log.
