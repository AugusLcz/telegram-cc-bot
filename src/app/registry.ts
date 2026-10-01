import type { Context } from "grammy";
import type { Target, ThreadKey } from "../core/types.ts";

/**
 * "chat": acts on the session of the chat it is sent in (/stop, /model …).
 * "bot":  bot-wide and mechanical (/projects, /settings …).
 * Both kinds work in every chat; the group only structures /help.
 */
export type CommandGroup = "chat" | "bot";

export interface CommandInput {
  ctx: Context;
  target: Target;
  /** The chat (tab) the command was sent in; absent only outside tabs. */
  key?: ThreadKey;
  name: string;
  args: string;
}

export interface CommandDef<A> {
  name: string;
  group: CommandGroup;
  /** Shown in /help and the Telegram menu. */
  description: string;
  /** e.g. "<name> <path>"; shown in /help. */
  usage?: string;
  /** Not listed in /help or the menu (aliases such as /start). */
  hidden?: boolean;
  run(app: A, input: CommandInput): Promise<void>;
}

/** Bot commands: handled mechanically, without Claude. Everything else goes to Claude Code. */
export class CommandRegistry<A> {
  private readonly defs = new Map<string, CommandDef<A>>();

  register(def: CommandDef<A>): this {
    if (this.defs.has(def.name)) throw new Error(`command /${def.name} registered twice`);
    this.defs.set(def.name, def);
    return this;
  }

  get(name: string): CommandDef<A> | undefined {
    return this.defs.get(name);
  }

  names(): Set<string> {
    return new Set(this.defs.keys());
  }

  /** Listed commands, in registration order, optionally of one group. */
  list(group?: CommandGroup): CommandDef<A>[] {
    return [...this.defs.values()].filter((d) => !d.hidden && (!group || d.group === group));
  }

  menu(): { command: string; description: string }[] {
    return this.list().map((d) => ({ command: d.name, description: d.description }));
  }
}

export type CallbackHandler<A> = (app: A, ctx: Context, payload: string) => Promise<void>;

/** Inline-button callbacks: data is `prefix:payload` (≤ 64 bytes). */
export class CallbackRouter<A> {
  private readonly handlers = new Map<string, CallbackHandler<A>>();

  on(prefix: string, handler: CallbackHandler<A>): this {
    if (prefix.includes(":")) throw new Error("callback prefix must not contain ':'");
    if (this.handlers.has(prefix)) throw new Error(`callback prefix ${prefix} registered twice`);
    this.handlers.set(prefix, handler);
    return this;
  }

  /** Returns false when no handler matches. */
  async dispatch(app: A, ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data ?? "";
    const i = data.indexOf(":");
    const handler = i > 0 ? this.handlers.get(data.slice(0, i)) : undefined;
    if (!handler) return false;
    await handler(app, ctx, data.slice(i + 1));
    return true;
  }
}

export function callbackData(prefix: string, payload: string | number): string {
  const data = `${prefix}:${payload}`;
  if (Buffer.byteLength(data) > 64) throw new Error(`callback data too long: ${data}`);
  return data;
}
