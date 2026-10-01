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
