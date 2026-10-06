# 0009. `/resume` continues a session in the chat it is sent from

Status: accepted (0.2.2)

## Context
Up to 0.2.1, `/resume` opened the chosen session in a new chat. Users expect Claude Code's own
behaviour: `/resume` switches the current conversation. Recovering a chat whose binding was lost also
needs "continue that session here".

## Decision
- `/resume` (list, `all`, or an ID) rebinds the chat it is sent from: its process is closed, the record
  points to the chosen session (`started`, its cwd and project), and the chat is renamed after the
  session unless the user named it. A recap of the last exchange is posted.
- The chat's previous session stays on disk and in the `/resume` list.
- A session already bound to another chat stays there; the bot points to that chat (one chat per
  session).
- Refused while Claude is working in the chat (`/stop` first).
- Outside any chat (no thread), it still opens a new chat.

## Consequences
- Normal use needs no `/resume`: every chat continues its own session automatically
  ([0003](0003-sessions-are-not-processes.md)).
- Code: `ThreadService.resumeHere` and `resumeIntoTab` (`src/domain/threads.ts`), `openResumed`
  (`src/app/control.ts`).
