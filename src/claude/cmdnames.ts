/**
 * Telegram bot-menu commands must match [a-z0-9_]{1,32}; Claude Code commands
 * and skills may contain "-", ":" or capitals (e.g. "code-review",
 * "plugin:skill"). This keeps a two-way mapping between the two spellings.
 */

const TG_NAME = /^[a-z0-9_]{1,32}$/;

export function toTelegramName(name: string): string | null {
  const tg = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return TG_NAME.test(tg) ? tg : null;
}

export class CommandNameMap {
  private tgToClaude = new Map<string, string>();

  /**
   * Rebuild from Claude's command list. Names in `reserved` (the bot's own
   * commands) are never shadowed. Returns the mapped [tgName, claudeName] pairs.
   */
  rebuild(claudeNames: string[], reserved: Set<string>): [string, string][] {
    this.tgToClaude.clear();
    const pairs: [string, string][] = [];
    for (const name of claudeNames) {
      const tg = toTelegramName(name);
      if (!tg || reserved.has(tg) || this.tgToClaude.has(tg)) continue;
      this.tgToClaude.set(tg, name);
      pairs.push([tg, name]);
    }
    return pairs;
  }

  /** Resolve what the user typed (menu spelling or original spelling) to a Claude command name. */
  resolve(typed: string, claudeNames: readonly string[]): string | null {
    if (claudeNames.includes(typed)) return typed;
    return this.tgToClaude.get(typed.toLowerCase()) ?? null;
  }
}

/** Parse "/cmd@botname rest" into its parts; null when the text is not a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = text.match(/^\/([^\s@]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1], args: (m[2] ?? "").trim() };
}

/**
 * Claude Code's own commands that work headless and are useful from Telegram:
 * the only ones the / menu lists besides the bot's. Skills stay out of the menu
 * (/skills lists them) but can always be typed.
 */
export const MENU_CLAUDE_COMMANDS: ReadonlySet<string> = new Set([
  "compact",
  "context",
  "usage",
  "clear",
  "config",
  "output-style",
  "add-dir",
  "reload-skills",
  "reload-plugins",
  "skill-doctor",
  "recap",
  "goal",
  "advisor",
  "autocompact",
  "fast",
  "list-agents",
  "init",
  "insights",
  "team-onboarding",
]);

/**
 * Claude Code built-ins that are not skills and mean nothing over Telegram
 * (terminal screens, account and install flows, host integrations).
 */
const TERMINAL_COMMANDS: ReadonlySet<string> = new Set([
  "agents", "artifacts", "auto-mode-setup", "autofix-pr", "background", "branch", "brief",
  "btw", "bug", "cd", "cloud-plugins", "color", "copy", "daemon", "design-consent", "design-login", "design-revoke",
  "desktop", "diff", "effort", "exit", "export", "extra-usage", "feedback", "focus", "fork", "heapdump",
  "help", "hooks", "ide", "import", "install", "install-github-app", "install-slack-app", "login", "logout", "loops",
  "mcp", "memory", "mobile", "model", "passes", "permissions", "plan", "plugin", "plugin-types", "powerup",
  "privacy-settings", "pro-trial-expired", "radio", "rate-limit-options", "release-notes", "remote-control",
  "remote-env", "rename", "resume", "rewind", "scroll-speed", "session", "setup-bedrock", "setup-vertex", "skills",
  "status", "stickers", "stop", "subtask", "tasks", "teleport", "terminal-setup", "theme", "tui", "ultraplan",
  "ultrareview", "upgrade", "update", "usage-credits", "version", "vim", "voice", "web-setup", "wellbeing",
  "workflow-launch-exec", "workflows",
]);

export type CommandKind = "menu" | "skill" | "own-skill" | "hidden";

/**
 * - "menu": a Claude Code command listed in the / menu;
 * - "own-skill": a skill or command from the user, a project, a plugin or an MCP server;
 * - "skill": one of Claude Code's bundled skills (code-review, simplify…);
 * - "hidden": a terminal-only or internal ("_name") built-in, or one the bot implements itself.
 */
export function commandKind(cmd: { name: string; builtin?: boolean }, botCommands: ReadonlySet<string>): CommandKind {
  if (!cmd.builtin) return "own-skill";
  if (cmd.name.startsWith("_")) return "hidden";
  if (botCommands.has(cmd.name)) return "hidden";
  if (MENU_CLAUDE_COMMANDS.has(cmd.name)) return "menu";
  return TERMINAL_COMMANDS.has(cmd.name) ? "hidden" : "skill";
}
