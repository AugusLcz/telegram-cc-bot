# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-02

### Changed

- Deployment: installing Claude Code and signing in is now a prerequisite, done once by the user
  as the account that runs the bot (by default the account that ran `sudo`). `deploy.sh` checks it
  first and stops with the exact commands to run instead of creating a `claude` account and running
  an interactive login, which could hang over SSH. The bot shares that account's Claude login,
  skills and settings; `--user` selects a dedicated account.

### Fixed

- `deploy.sh` could hang right after "Claude Code … ✓" in the prerequisites check. Commands run as
  the bot's account now get stdin from `/dev/null`, a hard timeout, and output through a temp file
  so that background helpers they leave behind (such as Claude Code's auto-updater) can't block the
  script; checks also disable Claude Code's auto-update and non-essential traffic. A timeout now
  produces a clear message instead of waiting.
- A 409 Conflict (another program polling the same bot token) crashed the bot, and systemd restarted
  it every 5 seconds, so the two pollers kept stealing each other's messages. The bot now logs the
  conflict clearly and retries with backoff (15 s up to 5 min); an invalid token (401) exits once.
- Claude Code sessions no longer inherit `TELEGRAM_BOT_TOKEN` from the bot.
- Only one copy of the bot can run per bot on a machine, whichever account or directory starts it:
  a second one (a manual `bun src/index.ts` next to the service, a second install directory…)
  refuses to start and names the PID of the running one. The polling and 409 log lines include the
  PID, and a 409 is logged with Telegram's own description.
- A webhook left on the bot is removed at start (and if one is set later), since it makes every
  long poll fail with 409.
- `deploy.sh install` stopped a running bot only after the prerequisites check, and older versions
  not at all while it waited to auto-restart, so the previous version kept answering messages in
  the middle of an install. The bot is now stopped first, with its PID and start time printed.
- `deploy.sh install` and `update` now make sure the bot will be the only client polling before
  starting it: they list local processes using the token (environment, command line, or a `.env`
  in their working directory, which is how `bun src/index.ts` reads it and which the previous
  check missed) with how each was started (login session, systemd unit, Docker), offer to stop
  them, and ask Telegram, with the bot stopped, whether anything else still polls: a 409 or
  messages confirmed by someone else are proof, a quiet 40 s rules it out. `check` does the same
  when the bot is down.
- `deploy.sh` no longer suggests `bun src/index.ts` to debug a module error (that started a second
  bot next to the service), and it judges a fresh start by its own log lines instead of older runs'.

### Removed

- `deploy.sh login` (sign in with `claude` → `/login` as the bot's account instead).

### Documentation

- New "Prerequisites" section in both READMEs: subscription, Claude Code install and sign-in
  (including over SSH and with `setup-token`), Telegram bot with Threaded Mode, runtime.

## [0.1.0] - 2026-10-01

First release.

### Added

- Telegram front end for real, unmodified Claude Code processes via the Agent SDK, signed in with
  the user's own Claude subscription.
- Chats are sessions: with Threaded Mode, every new chat with the bot is its own Claude Code session
  in the active project. The chat ↔ session mapping is persisted and bound lazily on first use.
- Mechanical bot commands that work in every chat without involving Claude: `/help`, `/status`,
  `/sessions`, `/resume`, `/projects`, `/project add|use|rm`, `/settings`, and per-chat `/stop`,
  `/model`, `/mode`, `/effort`, `/verbose`, `/rename`, `/fork`, `/close`, `/delete`.
- Passthrough of Claude Code's own slash commands, skills and plugin commands, with Telegram menu
  name mapping (`/code_review` → `/code-review`).
- Process pool: lazy start, idle hibernation (`SESSION_IDLE_MINUTES`), LRU eviction and admission
  queue (`MAX_LIVE_SESSIONS`), protection of busy sessions, transparent resume with persisted
  per-chat model, permission mode and effort.
- Streaming previews (`sendMessageDraft` with edit fallback), Markdown → Telegram HTML, compact tool
  status, permission prompts / questions / plan approval as inline buttons.
- Allowlist from `.env`; unknown users only learn their user ID.
- One-step deployment with built-in self-checks (`deploy/deploy.sh`), Threaded Mode checks, and a
  real Bot API spike script (`scripts/topics-spike.ts`).
- Architecture document, English and Chinese READMEs, 66 tests.

[Unreleased]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AugusLcz/telegram-cc-bot/releases/tag/v0.1.0
