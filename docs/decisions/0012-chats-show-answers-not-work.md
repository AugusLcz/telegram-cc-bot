# 0012. Chats show Claude's answers, not its work

Status: accepted (0.4.0)

## Context
Up to 0.3.0 a chat received everything Claude did during a turn, each as its own message: the notes it
writes between steps ("I'll pull the data first…"), a status message per run of tool calls
(`💻 Bash …`, `🌐 WebFetch …`), and with `/verbose` the tool output too. On a phone the answer was
buried under messages nobody needed. The typing action already ran during turns, but it is easy to
miss: it shows only in the chat header and pauses whenever the bot sends a message.

## Decision
- **Answers only, by default.** A text block that a tool call follows was a note on the way, so it is
  dropped. Text still held when the turn's `result` arrives is the answer. Text can't be classified
  while it streams, so without `/thinking` there is no live preview: the answer arrives whole.
- **Tool calls are never shown**: no status messages, no subagent lines, no tool output. Permission
  prompts and questions still are, since they need the user.
- **`/thinking`** (per chat; the default for new chats is in `/settings`; it replaced `/verbose`, which
  remains an alias) shows the notes as they come, with a live preview. It also shows thinking summaries as
  expandable quotes, permission denials and turn timings.
  - Recent models return thinking without text unless asked, so the bot asks for summaries with
    `setMaxThinkingTokens(null, "summarized")`, and with `null` to go back.
  - This happens when a process starts with the setting on, and when it is toggled.
  - A `null` budget keeps the session's own thinking budget.
- **Working indicator: a message plus the typing action.**
  - From 2 s into a turn, a silently sent `⏳ Working… 1m 20s` message with a ⏹ Stop button is kept as
    the chat's last message: it is deleted before anything else is sent and sent again below it.
  - While a prompt waits for the user it is hidden and typing pauses.
  - It is deleted before the answer is sent, so the answer is a new message that notifies.
  - The 2 s delay keeps quick replies from flashing it; the elapsed time is edited every 10 s within the
    per-chat budget.

## Consequences
- **Turns that end without an answer show nothing extra.** If a turn ends on a tool call (interrupted)
  it shows only the result notice; a crash loses held text (the crash notice says to resend).
- **Per-turn cost:** one send, one delete, and one edit every 10 s.
- **Stored state.** The stored field is `thinking`; `JsonFileStore` turns a `verbose` written by
  earlier versions into it on load.
- **Code:**
  - `TurnRenderer` (`src/telegram/render.ts`);
  - `WorkingMessage` (`src/telegram/working.ts`);
  - `SdkProcess.setShowThinking` (`src/claude/process.ts`);
  - `ThreadService.setThinking`;
  - `stopTurn` and the `stop` button (`src/app/thread.ts`);
  - `upgrade` (`src/store/store.ts`).
