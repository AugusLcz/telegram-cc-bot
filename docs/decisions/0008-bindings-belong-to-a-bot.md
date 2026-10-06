# 0008. Chat ↔ session bindings belong to one bot

Status: accepted (0.2.2; 0.2.1's version dropped bindings and is superseded)

## Context
A private chat's ID is the user's ID whichever bot it is with, but topic (chat) IDs are the bot's
own. After a token change, a new chat of the new bot can carry the same `threadId` as an old chat of
the old bot, and would continue the wrong session. 0.2.1 recorded the bot ID and dropped all bindings
when it was missing or different; upgrading from 0.2.0 (no ID recorded yet) therefore cut every
existing chat off its session.

## Decision
- `state.botId` names the bot the bindings belong to (`claimStateForBot`, `src/domain/chats.ts`, at
  startup in `src/index.ts`).
- No recorded bot: the state is taken as the current bot's; nothing is lost.
- A different bot: its bindings move to `state.botArchive[oldBotId]`, and the new bot's archived
  bindings (if it served this state before) come back. Bindings are never deleted.
- Projects and per-user defaults are shared across bots.

## Consequences
- Switching the token back and forth restores each bot's chats.
- Sessions are never lost either way: transcripts stay on disk and `/resume` reopens them.
- Chats affected by 0.2.1 recover with one `/resume` in the chat (see [0009](0009-resume-continues-in-place.md)).
