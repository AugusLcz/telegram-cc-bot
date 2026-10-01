# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AugusLcz/telegram-cc-bot/releases/tag/v0.1.0
