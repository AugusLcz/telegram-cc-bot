# 0005. Long polling with exactly one poller per token

Status: accepted (0.2.0)

## Context
Telegram serves one `getUpdates` client per bot token: when a second one asks, the waiting request
fails with `409 Conflict: terminated by other getUpdates request`, and messages are split between the
two. Early versions crashed on 409 and systemd restarted them every 5 s, turning any overlap into a
permanent fight. The real-world second poller turned out to be Claude Code's Telegram channel plugin,
loaded into every session the bot started (see [0007](0007-session-settings-the-bot-imposes.md)).
Webhooks need a public HTTPS endpoint, which a home server usually lacks.

## Decision
- Long polling through one loop: `Poller` (`src/telegram/polling.ts`) wraps grammY's runner. A 409 is
  logged with Telegram's own description and the PID, then retried with backoff (15 s doubling to
  5 min); a 401 exits once; other errors retry after 10 s. A runner restarts only after the previous
  one ended.
- A per-bot instance lock in `/tmp` (`src/core/instance-lock.ts`) stops a second copy of this bot on
  the same machine, whoever starts it.
- A webhook left on the bot is removed at start (and if one appears later).
- Claude Code processes never see `TELEGRAM_BOT_TOKEN`, and the Telegram channel plugin is off in
  them.
- `deploy.sh` lists local processes and config files that hold the token (environment, command line,
  `.env` in the working directory) with how each was started.

## Consequences
- Claude sessions never talk to Telegram; any number of chats share one poller. A test drives the real
  runner with two sessions and asserts one `getUpdates` in flight (`test/bot.test.ts`).
- A second copy elsewhere (another machine) still conflicts; the logs and `deploy.sh check` make that
  visible rather than silent.
