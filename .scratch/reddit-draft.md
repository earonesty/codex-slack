Title: I built a small MIT-licensed Slack bridge to native Codex sessions

For a while I was using Hermes as a poor man's Codex bridge. It worked, but I kept fighting the extra layer: surprising memory decisions across projects, and less control over scheduled work than I wanted.

I looked at existing open-source bridges before writing another one. There are good options, including ones with steering and interruption already. What I wanted was a narrow bridge that lets Codex own its sessions and configuration, with no routing model, terminal scraping, private SDK imports, or edits to Codex's session files.

So I built codex-slack:

- **Channel = project directory; Slack thread = Codex session.** New top-level messages start sessions. Replies continue them or steer active work.
- **Native interruption.** `!stop` requests interruption of that thread's active Codex turn.
- **Direct routing.** One long-lived Codex app-server, with no extra model call to decide where your message goes.
- **Persistent scheduling.** Cron with timezones, one-shot tasks, pause/resume, run history, and overlap protection for scheduled work in the same or nested directories. Quiet jobs only surface results or things needing attention. Questions and approvals come back through Slack.
- **Your machine, your Slack app.** Explicit user allowlist, channel-to-directory bindings, MIT license.
- **Tests for the awkward cases.** Duplicate events, uncertain delivery, reconnects, interruption, permissions, scheduling, and restart recovery. The tests use a fake Codex subprocess and fake Slack delivery.

Ordinary sessions inherit your Codex permissions. Scheduled jobs currently run with full filesystem/network access and no approval prompts, so that's a limitation to understand before using them. Directory bindings set project context; they don't create a memory or filesystem isolation boundary.

It's early and intentionally small: text only, completed-message delivery rather than token streaming, and no attachment to an already-running terminal session. I'd be interested in feedback on the design and failure cases.

https://github.com/earonesty/codex-slack
