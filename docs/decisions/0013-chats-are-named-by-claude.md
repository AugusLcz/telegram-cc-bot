# 0013. Chats are named once, by Claude

Status: accepted (0.5.0)

## Context
Up to 0.4.0 a chat was named after the first line of its first prompt, up to 40 characters. Names
were long, often half a sentence. A chat whose first message was a skill (`/deep-research …`) or a
photo kept its placeholder, and the next plain question renamed it, even days later.

Claude Code and the desktop app name sessions differently:
- On the first non-command message, Claude Code asks a small model for a title and appends it to the
  transcript (`{"type":"ai-title"}`). The title is a 2–5 word noun phrase in the conversation's language
  (or the `language` setting).
- This also happens for sessions the Agent SDK drives. It runs in the background, in parallel with the
  answer.
- `getSessionInfo().customTitle` returns it: a user's custom title, else the AI title.
- No title is made for slash commands or skills, for very short messages, or when generation fails.
- Hosts can ask for one with the `generate_session_title` control request.
  `Query.generateSessionTitle(description, { persist })` sends it, but the SDK's typings don't declare
  it (0.3.286).

## Decision
- A chat with an implicit name is named once, after its first message reaches Claude, in this order:
  1. **Claude Code's own title** for the session. The bot looks 6 s after the first message, so a long
     first answer doesn't delay the name, and again when the first answer is done (waiting 3 s more if
     the answer came first).
  2. **A title Claude generates** from the first message and answer via `generateTitle`, persisted so
     `/resume` and the desktop app show the same. Feature-detected; a failure just moves on.
  3. **The prompt's first line**, as before.
- After that (`titleSource: "auto"`), the bot never renames the chat. There is no provisional name:
  each rename leaves a service message in the chat.
- A chat whose session started while this process wasn't waiting for its name keeps its name (older
  chats, a restart in between).
- Names the user gives (in Telegram or with `/rename <title>`) are never overwritten.
- `/rename` without a title asks Claude for a title from the transcript. That is how older chats get a
  short name.

## Consequences
- **Timing.** A new chat keeps Telegram's own name for a few seconds, at most until the first answer.
- **Language.** Titles follow the conversation's language, so Chinese questions get Chinese titles.
- **Cost.** One small-model call per chat (Claude Code's own; the bot adds one only when Claude Code
  made none) and one per `/rename` without a title.
- **SDK upgrades.** The fallback depends on an undeclared SDK method. When the SDK is upgraded, check
  that chats starting with a skill still get a generated title, not the first line.
- **Code:**
  - `ThreadService.awaitName`, `nameChat`, `claudeCodeTitle`, `renameByClaude`
    (`src/domain/threads.ts`);
  - `SdkProcess.generateTitle` (`src/claude/process.ts`).
