# 0010. Commands in the menu, skills in a browser

Status: accepted (0.3.0; `/skills` browser after 0.3.0)

## Context
Claude Code's built-ins come as `prompt` commands, `local` commands (headless when marked
`supportsNonInteractive`) and `local-jsx` terminal screens. Only the first two run under the SDK, so
screens like `/skills`, `/mcp`, `/tasks` or `/diff` did nothing from Telegram. The `/` menu mixed
everything (bot commands, Claude Code commands, dozens of skills) and Telegram caps it at 100 entries
with `[a-z0-9_]{1,32}` names.

## Decision
- `commandKind` (`src/claude/cmdnames.ts`) sorts what a session reports via `supportedCommands()`
  (`builtin` marks Claude Code's own):
  - `menu`: useful headless built-ins (`MENU_CLAUDE_COMMANDS`);
  - `own-skill`: user, project, plugin and MCP skills and commands;
  - `skill`: Claude Code's bundled skills;
  - `hidden`: terminal screens, account flows, internal (`_name`) and names the bot implements.
- The `/` menu lists commands only: the bot's, then `menu` ones. Skills are reachable through
  `/skills` and by typing; underscore spellings resolve through the catalog, which also learns names
  each session reports.
- Terminal screens worth having are bot commands (`src/app/inspect.ts`): `/agents`, `/mcp`, `/tasks`,
  `/diff`, `/export`, `/plan`, `/memory`, `/permissions`, `/hooks`, `/plugin`, `/branch`.
- `/skills` (`src/app/skills.ts`) is one message edited in place: tabs (yours / Claude Code's), 8 per
  page in two columns, a detail view with a `copy_text` button for `/name `, `/skills <words>` to
  filter. Buttons carry indexes into an in-memory snapshot (callback data ≤ 64 bytes).
- Introspection without a live session uses a throwaway probe process in the chat's directory
  (`withProbe`): no message, no transcript, no pool slot.

## Consequences
- New Claude Code built-ins appear as `skill` until classified; check with `npm run probe` and update
  `MENU_CLAUDE_COMMANDS` or `TERMINAL_COMMANDS`.
- Browser snapshots are in memory (50 most recent); after a restart old buttons say "outdated".
