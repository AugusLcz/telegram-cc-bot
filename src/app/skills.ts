import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { InlineKeyboard, type Context } from "grammy";
import { commandKind, toTelegramName } from "../claude/cmdnames.ts";
import { escapeHtml, truncate } from "../telegram/format.ts";
import { editHtml } from "../telegram/send.ts";
import { targetOf } from "../telegram/target.ts";
import type { App } from "./context.ts";
import { chatCwd, code, inspect, skillLine, typedName, uniqueCommands, type Run } from "./inspect.ts";
import { callbackData } from "./registry.ts";
import { reply } from "./views.ts";

/**
 * /skills as a browser in one message, edited in place: tabs (yours / Claude
 * Code's), pages of buttons, and a detail view per skill with a button that
 * copies "/name " for adding arguments. `/skills <words>` filters.
 */

const PAGE_SIZE = 8;
const PER_ROW = 2;
const LABEL_MAX = 20;
/** Browsers kept for their buttons; older ones answer "outdated". */
const KEEP = 50;

type Tab = "own" | "bundled";

export interface Browser {
  cwd: string;
  own: SlashCommand[];
  bundled: SlashCommand[];
  botNames: ReadonlySet<string>;
  tab: Tab;
  page: number;
  /** Set when the browser shows the matches of `/skills <filter>` instead of tabs. */
  filter?: string;
  matches?: SlashCommand[];
}

/** The skills the browser currently pages through. */
function current(b: Browser): SlashCommand[] {
  return b.matches ?? (b.tab === "own" ? b.own : b.bundled);
}

function pageCount(b: Browser): number {
  return Math.max(1, Math.ceil(current(b).length / PAGE_SIZE));
}

export function listView(b: Browser): { html: string; keyboard: InlineKeyboard } {
  const list = current(b);
  const pages = pageCount(b);
  b.page = ((b.page % pages) + pages) % pages;
  const first = b.page * PAGE_SIZE;
  const shown = list.slice(first, first + PAGE_SIZE);

  const lines = b.matches
    ? [`🔎 Skills matching “${escapeHtml(b.filter ?? "")}” · ${list.length}`]
    : [`🧩 <b>Skills</b> · ${code(b.cwd)} · ${b.own.length} yours · ${b.bundled.length} Claude Code`];
  if (!b.matches && !b.own.length) {
    lines.push("You have none of your own yet: add one as ~/.claude/skills/&lt;name&gt;/SKILL.md or in the project's .claude/skills/.");
  }
  if (!list.length) lines.push(b.matches ? "No skill matches. /skills lists them all." : "No skills found.");
  lines.push("", ...shown.map((c, i) => `${first + i + 1}. ${skillLine(c, b.botNames, 90)}`));

  const kb = new InlineKeyboard();
  if (!b.matches) {
    const tabs: [Tab, string, number][] = [
      ["own", "Yours", b.own.length],
      ["bundled", "Claude Code", b.bundled.length],
    ];
    const visible = tabs.filter(([, , n]) => n > 0);
    for (const [tab, label, n] of visible) kb.text(`${tab === b.tab ? "● " : ""}${label} (${n})`, callbackData("sk", `t:${tab}`));
    if (visible.length) kb.row();
  }
  shown.forEach((c, i) => {
    kb.text(truncate(`🧩 ${typedName(c.name, b.botNames)}`, LABEL_MAX), callbackData("sk", `s:${first + i}`));
    if ((i + 1) % PER_ROW === 0) kb.row();
  });
  if (shown.length % PER_ROW) kb.row();
  if (pages > 1) {
    kb.text("◀", callbackData("sk", `p:${b.page - 1}`))
      .text(`${b.page + 1}/${pages}`, callbackData("sk", "n"))
      .text("▶", callbackData("sk", `p:${b.page + 1}`));
  }
  return { html: lines.join("\n"), keyboard: kb };
}

export function detailView(b: Browser, index: number): { html: string; keyboard: InlineKeyboard } | undefined {
  const c = current(b)[index];
  if (!c) return undefined;
  const typed = typedName(c.name, b.botNames);
  // Tappable when it is the menu spelling; otherwise shown to copy.
  const name = typed === toTelegramName(c.name) ? `/${typed}` : code(`/${c.name}`);
  const hint = c.argumentHint ? ` <i>${escapeHtml(c.argumentHint)}</i>` : "";
  const lines = [
    `🧩 ${name}${hint}`,
    ...(c.description ? [escapeHtml(truncate(c.description.trim(), 1000))] : []),
    `<i>${c.builtin ? "Claude Code skill" : "Yours"}</i>`,
    "",
    `Tap ${name} to run it, or copy it and add arguments.`,
  ];
  const keyboard = new InlineKeyboard()
    .copyText(truncate(`📋 Copy /${typed}`, 40), `/${typed} `)
    .text("◀ Back", callbackData("sk", "b"));
  return { html: lines.join("\n"), keyboard };
}

/** Case-insensitive: every word must appear in the name or the description. */
export function filterSkills(skills: SlashCommand[], filter: string): SlashCommand[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return skills.filter((c) => words.every((w) => `${c.name} ${c.description}`.toLowerCase().includes(w)));
}

const browsers = new Map<string, Browser>();

function remember(id: string, b: Browser): void {
  browsers.set(id, b);
  while (browsers.size > KEEP) browsers.delete(browsers.keys().next().value!);
}

const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name);

const skills: Run = async (app, input) => {
  const cmds = uniqueCommands(await inspect(app, input, (h) => h.supportedCommands()));
  app.catalog.learn(cmds.map((c) => c.name));
  const botNames = app.commands.names();
  const own = cmds.filter((c) => commandKind(c, botNames) === "own-skill").sort(byName);
  const bundled = cmds.filter((c) => commandKind(c, botNames) === "skill").sort(byName);
  const b: Browser = { cwd: chatCwd(app, input), own, bundled, botNames, tab: own.length ? "own" : "bundled", page: 0 };
  const filter = input.args.trim();
  let view = listView(b);
  if (filter) {
    b.filter = filter;
    b.matches = filterSkills([...own, ...bundled], filter);
    view = (b.matches.length === 1 && detailView(b, 0)) || listView(b);
  }
  const messageId = await reply(app, input.ctx, view.html, view.keyboard);
  remember(`${input.target.chatId}:${messageId}`, b);
};

async function onButton(app: App, ctx: Context, payload: string): Promise<void> {
  const msgId = ctx.callbackQuery?.message?.message_id;
  const b = msgId === undefined ? undefined : browsers.get(`${ctx.chat?.id}:${msgId}`);
  if (!b || msgId === undefined) return void (await ctx.answerCallbackQuery({ text: "This list is outdated; send /skills again." }));
  const [op, arg] = payload.split(":");
  let view: { html: string; keyboard: InlineKeyboard } | undefined;
  if (op === "t") {
    b.tab = arg === "bundled" ? "bundled" : "own";
    b.page = 0;
    view = listView(b);
  } else if (op === "p") {
    b.page = Number(arg) || 0;
    view = listView(b);
  } else if (op === "s") {
    view = detailView(b, Number(arg)) ?? listView(b);
  } else if (op === "b") {
    view = listView(b);
  }
  await ctx.answerCallbackQuery();
  if (view) await editHtml(app.api, targetOf(ctx)!, msgId, view.html, view.keyboard);
}

export function registerSkills(app: App): void {
  app.commands.register({ name: "skills", group: "chat", usage: "[filter]", description: "Browse the skills you can run in this chat", run: skills });
  app.callbacks.on("sk", onButton);
}
