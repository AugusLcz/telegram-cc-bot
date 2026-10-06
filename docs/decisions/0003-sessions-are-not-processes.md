# 0003. A session is not a process

Status: accepted (0.1.0)

## Context
A Claude Code process holds one conversation and costs hundreds of MB. Users open many chats and come
back to old ones days later. Keeping a process per chat is unbounded; killing sessions loses work.

## Decision
- The session's truth is its transcript on disk (written by Claude Code). A process is a disposable
  cache of it.
- `SessionPool` keeps at most `MAX_LIVE_SESSIONS` processes. Idle ones close after
  `SESSION_IDLE_MINUTES`; when full, the least recently used idle one is evicted; if all are busy, new
  turns wait in a FIFO queue (`/stop` cancels).
- A process is BUSY (never evicted) while a turn runs, a permission prompt waits, or non-ambient
  background tasks live (capped by `BACKGROUND_MAX_MINUTES`).
- The next message resumes transparently (`resume: sessionId`), with the chat's model, permission mode
  and effort re-applied. Those settings are persisted before they are applied live.

## Consequences
- Picking a session up and putting it down works like `claude --resume`, without user action.
- Anything that needs a living process between turns dies with hibernation: `/loop` wake-ups, cron
  tools. Listed in [ROADMAP](../ROADMAP.md).
- Slots are reserved synchronously before any `await`; tests in `test/pool.test.ts` pin every rule.
- Code: `src/claude/pool.ts`, `ThreadService.specFor`.
