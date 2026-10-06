# 0002. Every chat is one session; bot commands work in every chat

Status: accepted (0.1.0)

## Context
Telegram's Threaded Mode (Bot API 9.3+) gives a private chat with a bot topics, shown as separate
chats. In practice there is **no main view**: every message typed on the bot's main screen opens a
new chat. Bot command menus are scoped per private chat, not per topic, so every chat shows the same
menu.

## Decision
- One chat (topic, `message_thread_id`) = one Claude Code session in one project directory. The key is
  `chatId:threadId`.
- A chat is bound lazily: its record (session UUID chosen up front with `Options.sessionId`, project,
  cwd, per-chat settings) is created the first time it needs a session. Chats used only for bot
  commands leave nothing behind.
- Bot commands are mechanical (no Claude involved) and work in every chat: session commands act on the
  chat they are sent in, bot-wide ones (`/projects`, `/settings`…) anywhere.
- No `/new`: typing on the main screen is the new-chat gesture. `/resume` and `/fork` are the only
  ways the bot opens chats itself.
- A chat's project is fixed once its session starts; until then `/project use` moves it.

## Consequences
- Without Threaded Mode the bot cannot start sessions; it says how to enable it.
- Every other `/command` is passed to Claude Code, so bot command names shadow Claude Code's
  (`/status`, `/model`…); the bot implements those itself.
- Code: `src/domain/threads.ts` (`ThreadService`, invariants), `src/app/thread.ts` (`ensureRecord`,
  `startTurn`), `src/app/bot.ts` (`route`).
