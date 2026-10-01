# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/AugusLcz/Telegram-cc-bot/releases/tag/v0.1.0
