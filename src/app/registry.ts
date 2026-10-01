import type { Context } from "grammy";
import type { Target, ThreadKey } from "../core/types.ts";

/** Where a command is available: the main view, inside tabs, or both. */
export type Scope = "main" | "thread" | "both";
export type Place = "main" | "thread";

export interface CommandInput {
  ctx: Context;
  target: Target;
  /** Set inside a tab. */
  key?: ThreadKey;
  name: string;
  args: string;
}

export interface CommandDef<A> {
  name: string;
  scope: Scope;
  /** Shown in /help and the Telegram menu. */
  description: string;
  /** e.g. "<name> <path>"; shown in /help. */
  usage?: string;
  run(app: A, input: CommandInput): Promise<void>;
}

/**
 * Bot commands by name and place. The same name may have one definition for
 * the main view and another for tabs (e.g. /status).
 */
export class CommandRegistry<A> {
  private readonly byName = new Map<string, Partial<Record<Place, CommandDef<A>>>>();
  private readonly order: CommandDef<A>[] = [];

  register(def: CommandDef<A>): this {
    const slot = this.byName.get(def.name) ?? {};
    const places: Place[] = def.scope === "both" ? ["main", "thread"] : [def.scope];
    for (const place of places) {
      if (slot[place]) throw new Error(`command /${def.name} registered twice for ${place}`);
      slot[place] = def;
    }
    this.byName.set(def.name, slot);
    this.order.push(def);
    return this;
  }

  resolve(name: string, place: Place): CommandDef<A> | undefined {
    return this.byName.get(name)?.[place];
  }

  /** Where else the command exists, for "use this in …" redirects. */
  otherPlace(name: string, place: Place): Place | undefined {
    const slot = this.byName.get(name);
    const other: Place = place === "main" ? "thread" : "main";
    return slot?.[other] ? other : undefined;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): Set<string> {
    return new Set(this.byName.keys());
  }

  /** Definitions available in a place, in registration order. */
  list(place: Place): CommandDef<A>[] {
    return this.order.filter((d) => d.scope === "both" || d.scope === place);
  }

  /** One menu entry per name (Telegram menus cannot differ per tab). */
  menu(): { command: string; description: string }[] {
    const seen = new Set<string>();
    const out: { command: string; description: string }[] = [];
    for (const d of this.order) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      out.push({ command: d.name, description: d.description });
    }
    return out;
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
