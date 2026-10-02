import { randomUUID } from "node:crypto";
import type { ModelInfo, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { silentLogger, type Logger } from "../core/logger.ts";
import type { PermissionMode } from "../core/types.ts";
import { toTelegramName } from "./cmdnames.ts";
import type { ProcessFactory, ProcessHandle } from "./process.ts";

/**
 * What Claude Code offers: slash commands (built-ins, skills, plugins) and
 * models. Used for the Telegram menu and model buttons. Filled by a short
 * probe at startup and refreshed from live processes.
 */
export class CommandCatalog {
  commands: SlashCommand[] = [];
  models: ModelInfo[] = [];
  version: string | undefined;
  private listeners = new Set<() => void>();
  /** Names seen in single chats (project skills…): resolvable, but not in the menu. */
  private learned = new Set<string>();

  get commandNames(): string[] {
    return this.commands.map((c) => c.name);
  }

  /** Map what the user typed (original or Telegram-menu spelling) to a Claude command name. */
  resolve(typed: string): string | undefined {
    const names = [...this.commandNames, ...this.learned];
    if (names.includes(typed)) return typed;
    const lower = typed.toLowerCase();
    return names.find((n) => toTelegramName(n) === lower);
  }

  /** Remember command names a chat's session reported, so their menu spelling resolves too. */
  learn(names: Iterable<string>): void {
    for (const n of names) this.learned.add(n);
  }

  update(next: { commands?: SlashCommand[]; models?: ModelInfo[]; version?: string }): void {
    let changed = false;
    if (next.commands && JSON.stringify(next.commands.map((c) => c.name)) !== JSON.stringify(this.commandNames)) {
      this.commands = next.commands;
      changed = true;
    }
    if (next.models?.length) this.models = next.models;
    if (next.version) this.version = next.version;
    if (changed) for (const fn of this.listeners) fn();
  }

  /** Called when the command list changes (menu sync). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Read commands and models once from a throwaway process in `cwd`. */
  async probe(factory: ProcessFactory, cwd: string, permissionMode: PermissionMode, log: Logger = silentLogger): Promise<void> {
    await withProbe(factory, cwd, permissionMode, async (h) => this.update({ commands: h.commands, models: h.models }), log);
  }
}

/**
 * Run `fn` against a throwaway Claude Code process in `cwd`, then close it. No
 * message is sent, so no transcript is written; it takes no pool slot.
 */
export async function withProbe<T>(
  factory: ProcessFactory,
  cwd: string,
  permissionMode: PermissionMode,
  fn: (handle: ProcessHandle) => Promise<T>,
  log: Logger = silentLogger,
): Promise<T> {
  const handle = factory.create(
    { sessionId: randomUUID(), resume: false, cwd, permissionMode },
    {
      canUseTool: async () => ({ behavior: "deny", message: "probe" }),
      onMessage: async () => {},
      onExit: () => {},
    },
  );
  try {
    await handle.start();
    return await fn(handle);
  } finally {
    await handle.close().catch((err) => log.warn("closing probe failed:", err));
  }
}
