# Operating the Slack bridge

Read README.md before changing daemon lifecycle or session delivery.

## Complete changes before deploying locally

The persistent local daemon runs this checkout. A successful test or local restart
does not complete branch work. Before a normal restart, merge the intended work
into `main`, run required checks, commit, push to `origin/main`, and verify a clean
working tree with local HEAD equal to the published remote main. Inspect unmerged
local branches for features still used by the daemon before rebuilding from main.
Do not delete branches containing unmerged work.

The restart helper enforces clean, published main by default. Use
`--allow-unpublished` only when temporary branch testing is explicitly intended;
finish by merging/pushing and restarting the published main checkout. Report the
commit, push, and live verification separately so temporary deployment cannot be
mistaken for completed integration.

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
