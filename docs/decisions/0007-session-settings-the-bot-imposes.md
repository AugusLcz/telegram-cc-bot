# 0007. What the bot imposes on every Claude Code session

Status: accepted (0.2.1)

## Context
Sessions load the service account's settings, skills and plugins (`settingSources: user, project,
local`), as the CLI would. Three defaults turned out wrong for a bot:

1. **No system prompt.** When `query()` gets no `systemPrompt`, the SDK sends an **empty** one (the
   CLI's prompt is not the SDK default). Sessions ran without Claude Code's instructions and kept
   talking about the working directory.
2. **Telegram channel plugin.** With Claude Code's official Telegram plugin enabled for the account,
   every session the bot started loaded it, and it polled Telegram: one extra poller per open chat,
   causing the 409 conflicts of [0005](0005-one-poller-per-token.md).
3. **The bot token in the environment.** Sessions inherited `TELEGRAM_BOT_TOKEN`, visible to any tool,
   hook or MCP server.

## Decision
In `SdkProcess.start` (`src/claude/process.ts`):
- `systemPrompt: { type: "preset", preset: "claude_code" }`. The bot adds no prompt text of its own.
- `settings: SESSION_FLAG_SETTINGS`, the flag-settings layer (above user, project and local), turns
  `telegram@claude-plugins-official` off.
- `env: claudeEnv()`: the bot's environment without `TELEGRAM_BOT_TOKEN`.

## Consequences
- With system-prompt recording, sessions created before 0.2.1 keep their empty prompt until `/compact`
  or `/clear`.
- The user's own `claude` still loads the plugin; if it holds this bot's token it competes.
  `deploy.sh` reports an enabled plugin and config files holding the token.
- Any new per-session override belongs in the same place, with a test (`test/polling.test.ts` checks
  the plugin flag and the environment).
