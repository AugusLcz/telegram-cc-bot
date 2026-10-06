# Decision records

Why the code is the way it is. Each record is short: the situation, the decision, what follows from it.
Read the relevant one before changing behaviour it covers; if you reverse a decision, add a new record
that supersedes it instead of editing history.

| # | Decision | Since |
|---|---|---|
| [0001](0001-agent-sdk-drives-real-claude-code.md) | The Agent SDK drives real, unmodified Claude Code, signed in with the user's subscription | 0.1.0 |
| [0002](0002-chats-are-sessions.md) | Every Telegram chat (topic) is one Claude Code session; bot commands work in every chat; no `/new` | 0.1.0 |
| [0003](0003-sessions-are-not-processes.md) | A session is not a process: bounded pool, hibernation, transparent resume | 0.1.0 |
| [0004](0004-allowlist-in-env.md) | The allowlist lives in `.env`; strangers only learn their user ID | 0.1.0 |
| [0005](0005-one-poller-per-token.md) | Long polling with exactly one poller per bot token | 0.2.0 |
| [0006](0006-claude-code-is-a-prerequisite.md) | Installing and signing in to Claude Code is a prerequisite, not a deploy step | 0.2.0 |
| [0007](0007-session-settings-the-bot-imposes.md) | The bot imposes three things on every session: Claude Code's system prompt, no Telegram channel plugin, no bot token | 0.2.1 |
| [0008](0008-bindings-belong-to-a-bot.md) | Chat ↔ session bindings belong to one bot; switching bots puts them aside | 0.2.2 |
| [0009](0009-resume-continues-in-place.md) | `/resume` continues a session in the chat it is sent from | 0.2.2 |
| [0010](0010-commands-in-the-menu-skills-in-a-browser.md) | Claude Code commands are classified; the `/` menu lists commands only; `/skills` is a browser | 0.3.0 |
| [0011](0011-deploy-script-design.md) | `deploy.sh`: prerequisites first, stop the bot first, settings from three sources, no Telegram probing | 0.2.0 |
| [0012](0012-chats-show-answers-not-work.md) | Chats show answers only; tool calls never; `/thinking` shows notes and thinking; a working message with Stop | 0.4.0 |
| [0013](0013-chats-are-named-by-claude.md) | Chats are named once, by Claude, with Claude Code's own session title | 0.5.0 |

Template for a new record (`NNNN-short-title.md`):

```markdown
# NNNN. Title

Status: accepted (vX.Y.Z)

## Context
What forced a decision; facts, constraints, what went wrong.

## Decision
What we do, precisely enough to check the code against it.

## Consequences
What follows, good and bad; what to watch when changing nearby code. Code pointers.
```
