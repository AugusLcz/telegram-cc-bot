import { InlineKeyboard, type Context } from "grammy";
import type { Recap } from "../claude/sessions.ts";
import type { SessionState } from "../claude/pool.ts";
import type { Target, ThreadRecord } from "../core/types.ts";
import { escapeHtml, truncate } from "../telegram/format.ts";
import { sendHtml } from "../telegram/send.ts";
import { targetOf } from "../telegram/target.ts";
import type { App } from "./context.ts";
import { callbackData } from "./registry.ts";

export function relTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const STATE_ICON: Record<SessionState, string> = {
  busy: "🟢",
  starting: "🟢",
  idle: "🟡",
  cold: "⚪",
};

/** First message posted into a tab. */
export function tabHeader(record: ThreadRecord, kind: "new" | "resumed" | "forked", recap?: Recap): string {
  const where = `📁 <b>${escapeHtml(record.project)}</b> · <code>${escapeHtml(record.cwd)}</code>`;
  if (kind === "new") return `${where}\n🆕 New session. Send a message to start.`;
  let html = `${kind === "forked" ? "🍴 Fork" : "▶️ Resumed"}: <b>${escapeHtml(truncate(record.title, 100))}</b>\n${where}`;
  if (recap?.user) html += `\n\n👤 ${escapeHtml(truncate(recap.user, 300))}`;
  if (recap?.assistant) html += `\n🤖 ${escapeHtml(truncate(recap.assistant, 500))}`;
  if (kind === "resumed") html += "\n\nSend a message to continue.";
  return html;
}

/** One button per option, current one marked. */
export function choiceKeyboard(prefix: string, options: { label: string; value: string }[], current?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const o of options) kb.text(truncate(`${o.value === current ? "▶ " : ""}${o.label}`, 48), callbackData(prefix, o.value)).row();
  return kb;
}

/** Reply in the same place (main view or tab) as the update. */
export function reply(app: App, ctx: Context, html: string, keyboard?: InlineKeyboard): Promise<number> {
  return sendHtml(app.api, targetOf(ctx)!, html, { keyboard });
}

export function replyTo(app: App, target: Target, html: string, keyboard?: InlineKeyboard): Promise<number> {
  return sendHtml(app.api, target, html, { keyboard });
}

export const THREADED_MODE_HINT =
  "⚠️ Tabs are off for this bot. In @BotFather open the bot → <b>Bot Settings → Threaded Mode</b>, enable it, then restart the bot.";
