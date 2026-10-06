# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-10-06

### Added

- A working message while Claude works: `⏳ Working… 1m 20s`, sent silently with a ⏹ Stop button. It stays
  at the bottom of the chat, steps aside while a prompt waits for you, and is deleted before the answer,
  which arrives as a new message with a notification.
- `/thinking` (per chat; default in `/settings`) shows Claude's notes between steps, its thinking
  summaries (requested from the API when on), permission denials and timings, with a live preview.

### Changed

- Chats show Claude's answers only. Notes between steps and tool calls (`💻 Bash …` status messages,
  subagent lines) are no longer sent; tool output isn't shown either. Without `/thinking` the answer
  arrives whole, without a live preview.
- `/thinking` replaces `/verbose` (still accepted). Chats and defaults that had verbose on have thinking on.
- `/skills` is a browser in one message instead of a long list. Tabs separate yours from Claude Code's,
  with 8 skills per page in two columns and ◀ ▶ to page through. Tapping a skill shows its full
  description and a button that copies `/name ` for adding arguments. `/skills <words>` filters, and a
  single match opens its details.

### Documentation

- `AGENTS.md` (with `CLAUDE.md` importing it) for coding agents and humans: commands, repository map,
  rules that must hold, recipes, definition of done, release steps, pitfalls.
- `docs/decisions/`: twelve records of why the design is what it is.
- `docs/TESTING.md` (test layers, the bot harness, fakes, live probes) and `docs/ROADMAP.md` (open
  items, limitations, risks). `docs/ARCHITECTURE.md` brought up to date.
- `npm run check` (typecheck, tests, shell syntax), `npm run test:deploy` (the `deploy.sh` tests, now in
  `deploy/test/`), `npm run probe` (what the real Claude Code offers, without sending a message).
- LF line endings for every file (`.gitattributes`, `.editorconfig`).

## [0.3.0] - 2026-10-02

### Added

- Telegram versions of Claude Code's terminal-only screens:
  - **`/skills`:** skills you can run in the chat; yours first, tappable.
  - **`/agents`:** the chat's subagents.
  - **`/mcp`:** the session's MCP servers, with Reconnect / Enable / Disable buttons and
    `/mcp reconnect|enable|disable <server|all>`.
  - **`/tasks` (`/bashes`):** background tasks, with Stop buttons.
  - **`/diff`:** git status and summary; the full patch as a file.
  - **`/export`:** the conversation as Markdown.
  - **`/plan [task]`:** switches the chat to plan mode, optionally with a task.
  - **`/branch`:** an alias of `/fork`.
  - **`/memory`:** loaded CLAUDE.md / AGENTS.md files.
  - **`/permissions` and `/hooks`:** read from the settings files.
  - **`/plugin`:** list, install, uninstall, enable, disable, update and marketplaces, through the
    `claude plugin` CLI; the chat's session reloads the plugins.
- `/skills` and `/agents` in a chat without a running session ask a short-lived Claude Code process in
  the chat's directory. It sends no message, writes no transcript and takes no slot.

### Changed

- The `/` menu lists commands only: the bot's, then Claude Code's useful headless ones. Skills are
  no longer in it; `/skills` lists them, and typing one runs it. A skill seen in a chat's session
  (even a project-only one) also resolves by its menu spelling.
- `/help` lists Claude Code's menu commands and points to `/skills`.

## [0.2.2] - 2026-10-02

### Changed

- `/resume` continues the chosen session in the chat it is sent from, like Claude Code's own
  `/resume`, instead of opening a new chat. The chat's previous session stays in the `/resume` list;
  a session already open in another chat stays there.

### Fixed

- v0.2.1 dropped every chat ↔ session binding on its first start when upgrading from v0.2.0 (the state
  did not record the bot yet), so existing chats started over. A state without a recorded bot is now
  taken as the current bot's, and after a switch to another bot the old bindings are put aside and
  restored if the token is switched back, never deleted. Chats affected by v0.2.1 can get their
  session back with `/resume` in that chat.

## [0.2.1] - 2026-10-02

### Fixed

- Sessions ran without Claude Code's system prompt: left unset, the Agent SDK sends an empty one.
  They now use Claude Code's own (the bot adds nothing). Chats that already started keep the prompt
  they were recorded with until `/compact` or `/clear`.
- Claude Code's Telegram channel plugin, when installed for the bot's account, was loaded into every
  session the bot started and polled the bot too: the cause of the 409 Conflicts. It is now turned
  off in the bot's sessions, and `deploy.sh` says when it is enabled for the account.
- The `/` menu could stay without Claude Code's commands: it was set only for the default scope, so
  a menu set for private chats or a chat (by another program, earlier) hid it, and a rejected list
  left nothing. It is now set for the default scope, all private chats and each allowed user's
  chat; if Telegram rejects the full list, the bot's own commands still go in. The log reports
  `menu: N commands`, and `deploy.sh check` shows the count Telegram has.

- Changing the bot token had no effect on a re-run of `deploy.sh`: the service reads only the
  install directory's `.env`, the checkout's `.env` was never looked at, and `update` ignored
  exported settings. `install` and `update` now apply exported settings and list the values in
  the checkout's `.env` that differ (the token by its bot ID), copying them once confirmed (suggested
  only when that file is the newer one);
  `check` reports settings not applied yet, and the token check names the bot and the file.
- After a switch to another bot, a new chat could land on a session of the old bot's chat with the
  same number. Chat ↔ session bindings now belong to the bot they were made with and are dropped
  when the bot changes; the sessions stay available via `/resume`.

### Removed

- The 40-second Telegram check in `deploy.sh install`, `update` and `check`; the local check for
  processes and config files using the token stays.

### Documentation

- The Quick start says it is for a local run and not to combine it with a server deployment.

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

[Unreleased]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AugusLcz/telegram-cc-bot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AugusLcz/telegram-cc-bot/releases/tag/v0.1.0
