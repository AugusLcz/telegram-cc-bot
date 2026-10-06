# 0001. The Agent SDK drives real, unmodified Claude Code

Status: accepted (0.1.0)

## Context
The goal is Claude Code (its agent loop, tools, skills, CLAUDE.md, MCP, hooks, permissions, slash
commands) reachable from Telegram, billed to the user's Claude subscription. Harnesses that
re-implement the agent loop (OpenClaw and similar) lag behind Claude Code and behave differently.
Subscription OAuth may only be used by Anthropic's own Claude Code; a home-grown client calling the API
with that login is not allowed.

## Decision
- Use `@anthropic-ai/claude-agent-sdk`. Each session is one `query()` in streaming-input mode, which
  spawns the unmodified Claude Code binary the SDK bundles (or `CLAUDE_PATH`).
- Authentication is whatever that binary uses for the service account: its `claude` login, or
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. The bot never handles API keys.
- The bot is a thin front end: it relays messages, renders output, turns permission prompts into
  buttons and manages processes. Anything Claude Code can do itself stays in Claude Code.
- Runtime: Bun in production, Node.js 24 type stripping for tests; erasable TypeScript, no build step.

## Consequences
- Feature parity comes for free when the SDK updates; behaviour the SDK lacks (terminal-only screens)
  needs a Telegram version in the bot (see [0010](0010-commands-in-the-menu-skills-in-a-browser.md)).
- SDK defaults are not Claude Code CLI defaults; see [0007](0007-session-settings-the-bot-imposes.md)
  for the ones the bot must override.
- Usage counts against the user's plan. Anthropic announced, then paused, separate billing for SDK use.
- Code: `src/claude/process.ts` (`SdkProcess`), `src/claude/sessions.ts` (session store functions).
