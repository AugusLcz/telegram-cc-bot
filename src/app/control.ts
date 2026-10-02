import os from "node:os";
import { InlineKeyboard, type Context } from "grammy";
import { sessionTitle } from "../claude/sessions.ts";
import { EFFORTS, PERMISSION_MODES, targetOfKey, type ProjectRecord, type SessionSettings, type ThreadKey } from "../core/types.ts";
import { UserError } from "../domain/errors.ts";
import { escapeHtml, truncate } from "../telegram/format.ts";
import { editHtml } from "../telegram/send.ts";
import { keyOf, targetOf } from "../telegram/target.ts";
import type { App } from "./context.ts";
import { callbackData, type CommandInput } from "./registry.ts";
import { choiceKeyboard, relTime, reply, replyTo, STATE_ICON, tabHeader, THREADED_MODE_HINT } from "./views.ts";

/**
 * Bot-wide, mechanical commands (no Claude involved). They work in every
 * chat; replies stay in the chat they were sent from.
 */

const UUID_PREFIX = /^[0-9a-f]{8}(-[0-9a-f-]{1,28})?$/i;

function chatOf(ctx: Context): number {
  return ctx.chat!.id;
}

function requireTabs(app: App): void {
  if (!app.botInfo.hasTopics) throw new UserError(THREADED_MODE_HINT);
}

// ---- help --------------------------------------------------------------------

async function help(app: App, { ctx }: CommandInput): Promise<void> {
  const project = app.projects.activeFor(chatOf(ctx));
  const line = (d: { name: string; usage?: string; description: string }) =>
    `/${d.name}${d.usage ? ` ${escapeHtml(d.usage)}` : ""} — ${escapeHtml(d.description)}`;
  let html =
    `<b>Claude Code over Telegram</b>\n` +
    `Each chat is its own Claude Code session. Open a new chat from the bot's main screen to start one; ` +
    `it works in the active project <b>${escapeHtml(project.name)}</b> · <code>${escapeHtml(project.path)}</code>.\n` +
    `Anything that is not a bot command goes to Claude, including /compact, /context, /usage and your skills.\n\n` +
    `<b>This chat</b>\n${app.commands.list("chat").map(line).join("\n")}\n\n` +
    `<b>Bot</b>\n${app.commands.list("bot").map(line).join("\n")}`;
  if (!app.botInfo.hasTopics) html += `\n\n${THREADED_MODE_HINT}`;
  else if (!app.botInfo.usersCreateTopics) {
    html +=
      "\n\n⚠️ Users cannot open new chats with this bot, so new sessions can only come from /resume and /fork. " +
      "Allow it in @BotFather → Bot Settings → Threaded Mode.";
  }
  await reply(app, ctx, html);
}

// ---- projects ------------------------------------------------------------------

/** Make `project` active for new chats, and for this chat too if its session has not started. */
function applyProject(app: App, chatId: number, key: ThreadKey | undefined, project: ProjectRecord): string {
  app.projects.use(chatId, project.name);
  const where = `<b>${escapeHtml(project.name)}</b> · <code>${escapeHtml(project.path)}</code>`;
  if (!key || app.threads.setProject(key, project)) return `📁 This chat and new chats use ${where}.`;
  const current = app.threads.get(key)!;
  return `📁 New chats will use ${where}.\nThis chat stays in <b>${escapeHtml(current.project)}</b>: its session already started there.`;
}

function projectList(app: App, chatId: number): { html: string; kb: InlineKeyboard } {
  const active = app.projects.activeFor(chatId);
  const projects = app.projects.list();
  const lines = projects.map(
    (p) => `${p.name === active.name ? "▶" : "•"} <b>${escapeHtml(p.name)}</b> · <code>${escapeHtml(p.path)}</code>`,
  );
  const html =
    `<b>Projects</b> (new chats start in the ▶ one)\n\n${lines.join("\n")}\n\n` +
    `/project add &lt;name&gt; &lt;path&gt; · /project use &lt;name&gt; · /project rm &lt;name&gt;`;
  return { html, kb: choiceKeyboard("pj", projects.map((p) => ({ label: p.name, value: p.name })), active.name) };
}

async function projects(app: App, { ctx }: CommandInput): Promise<void> {
  const { html, kb } = projectList(app, chatOf(ctx));
  await reply(app, ctx, html, kb);
}

async function project(app: App, input: CommandInput): Promise<void> {
  const { ctx, args, key } = input;
  const [sub = "", name = ""] = args.split(/\s+/).filter(Boolean);
  const chatId = chatOf(ctx);
  switch (sub) {
    case "add": {
      const rawPath = args.replace(/^\s*add\s+\S+\s*/, "");
      if (!name || !rawPath) throw new UserError("Usage: /project add &lt;name&gt; &lt;path&gt;");
      const p = app.projects.add(name, rawPath);
      await reply(app, ctx, `✅ Added <b>${escapeHtml(p.name)}</b>.\n${applyProject(app, chatId, key, p)}`);
      return;
    }
    case "use": {
      if (!name) throw new UserError("Usage: /project use &lt;name&gt;");
      const p = app.projects.get(name);
      if (!p) throw new UserError(`No project named "${escapeHtml(name)}". See /projects.`);
      await reply(app, ctx, applyProject(app, chatId, key, p));
      return;
    }
    case "rm":
    case "remove": {
      if (!name) throw new UserError("Usage: /project rm &lt;name&gt;");
      app.projects.remove(name);
      await reply(app, ctx, `🗑 Removed <b>${escapeHtml(name)}</b>. Chats that use it keep working.`);
      return;
    }
    case "":
      return projects(app, input);
    default:
      throw new UserError("Usage: /project add|use|rm …");
  }
}

async function onProjectButton(app: App, ctx: Context, name: string): Promise<void> {
  const p = app.projects.get(name);
  if (!p) throw new UserError(`No project named "${escapeHtml(name)}".`);
  const text = applyProject(app, chatOf(ctx), keyOf(targetOf(ctx)!), p);
  await ctx.answerCallbackQuery({ text: `Active project: ${name}` });
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, text);
}

// ---- sessions ------------------------------------------------------------------

/** Continue a past session in the chat /resume was used in (a new chat when there is none). */
async function openResumed(app: App, ctx: Context, sessionId: string): Promise<string> {
  requireTabs(app);
  const here = targetOf(ctx);
  const hereKey = here && keyOf(here);
  const tab = hereKey ? await app.threads.resumeHere(hereKey, sessionId) : await app.threads.resumeIntoTab(chatOf(ctx), sessionId);
  const target = targetOfKey(tab.key);
  if (("elsewhere" in tab && tab.elsewhere) || ("existed" in tab && tab.existed)) {
    await replyTo(app, target, "👋 This session is open here.");
    return `Already open in chat "${tab.record.title}"`;
  }
  if ("already" in tab && tab.already) return "This chat already continues that session";
  const recap = await app.sessions.recap(tab.record.sessionId, tab.record.cwd).catch(() => undefined);
  await replyTo(app, target, tabHeader(tab.record, "resumed", recap));
  return hereKey ? `Continuing "${tab.record.title}" here` : `Opened "${tab.record.title}" in a new chat`;
}

async function resume(app: App, { ctx, args }: CommandInput): Promise<void> {
  const arg = args.trim();
  if (arg && arg !== "all") {
    if (!UUID_PREFIX.test(arg)) throw new UserError("Usage: /resume, /resume all or /resume &lt;session-id&gt;");
    await reply(app, ctx, `▶️ ${escapeHtml(await openResumed(app, ctx, arg))}`);
    return;
  }
  const all = arg === "all";
  const active = app.projects.activeFor(chatOf(ctx));
  const sessions = await app.sessions.list({ dir: all ? undefined : active.path, limit: 10 });
  if (sessions.length === 0) {
    await reply(app, ctx, all ? "No past sessions." : `No past sessions in <b>${escapeHtml(active.name)}</b>. Try /resume all.`);
    return;
  }
  const kb = new InlineKeyboard();
  const lines = sessions.map((s, i) => {
    const pinned = app.threads.findBySession(s.sessionId) ? "📌 " : "";
    const title = sessionTitle(s);
    kb.text(truncate(`${pinned}${i + 1}. ${title}`, 48), callbackData("rs", s.sessionId)).row();
    const where = all && s.cwd ? ` · <code>${escapeHtml(s.cwd)}</code>` : "";
    return `${i + 1}. ${pinned}<b>${escapeHtml(truncate(title, 80))}</b>\n    ${relTime(s.lastModified)}${s.gitBranch ? ` · ${escapeHtml(s.gitBranch)}` : ""}${where}`;
  });
  const scope = all ? "all projects" : `<b>${escapeHtml(active.name)}</b>`;
  await reply(
    app,
    ctx,
    `Continue a past session from ${scope} in this chat (📌 open in a chat already). ` +
      `This chat's current session stays in this list.\n\n${lines.join("\n")}`,
    kb,
  );
}

async function onResumeButton(app: App, ctx: Context, sessionId: string): Promise<void> {
  const text = await openResumed(app, ctx, sessionId);
  await ctx.answerCallbackQuery({ text: truncate(text, 190) });
}

async function sessions(app: App, { ctx }: CommandInput): Promise<void> {
  const tabs = app.threads.list(chatOf(ctx)).filter(({ key, record }) => record.started || app.pool.state(key) !== "cold");
  const stats = app.pool.stats();
  const head = `<b>Sessions</b> · live ${stats.live}/${stats.max}${stats.waiting ? ` · ${stats.waiting} waiting` : ""}`;
  if (tabs.length === 0) {
    await reply(app, ctx, `${head}\n\nNo sessions yet. Open a new chat from the bot's main screen and send a message.`);
    return;
  }
  const kb = new InlineKeyboard();
  const lines = tabs.map(({ key, record }, i) => {
    const icon = STATE_ICON[app.pool.state(key)];
    if (i < 10) kb.text(truncate(`${icon} ${record.title}`, 48), callbackData("go", record.threadId)).row();
    return `${icon} <b>${escapeHtml(truncate(record.title, 60))}</b> · ${escapeHtml(record.project)} · ${relTime(record.lastActiveAt)}`;
  });
  await reply(app, ctx, `${head}\n🟢 busy · 🟡 idle · ⚪ hibernated\nTap one to jump to its chat.\n\n${lines.join("\n")}`, kb);
}

async function onGoButton(app: App, ctx: Context, threadId: string): Promise<void> {
  await replyTo(app, { chatId: chatOf(ctx), threadId: Number(threadId) }, "👋 Here.");
  await ctx.answerCallbackQuery({ text: "Posted in that chat" });
}

// ---- settings ----------------------------------------------------------------

export function modelOptions(app: App): { label: string; value: string }[] {
  return [{ label: "Default", value: "default" }, ...app.catalog.models.map((m) => ({ label: m.displayName, value: m.value }))];
}

export const modeOptions = () => PERMISSION_MODES.map((m) => ({ label: m, value: m }));
export const effortOptions = () => [{ label: "Default", value: "default" }, ...EFFORTS.map((e) => ({ label: e, value: e }))];

function settingsView(app: App, chatId: number): { html: string; kb: InlineKeyboard } {
  const d = app.chats.ensure(chatId).defaults;
  const html =
    `<b>Defaults for new chats</b>\n` +
    `🧠 Model: <code>${escapeHtml(d.model ?? "default")}</code>\n` +
    `🔐 Permission mode: <code>${d.permissionMode}</code>\n` +
    `🎚 Effort: <code>${d.effort ?? "default"}</code>\n` +
    `🔊 Verbose: ${d.verbose ? "on" : "off"}\n\n` +
    `<i>Existing chats keep their own settings: use /model, /mode, /effort, /verbose inside them.</i>`;
  const kb = new InlineKeyboard()
    .text("🧠 Model", callbackData("set", "model"))
    .text("🔐 Mode", callbackData("set", "mode"))
    .row()
    .text("🎚 Effort", callbackData("set", "effort"))
    .text(`🔊 Verbose ${d.verbose ? "off" : "on"}`, callbackData("set", "verbose"));
  return { html, kb };
}

async function settings(app: App, { ctx }: CommandInput): Promise<void> {
  const { html, kb } = settingsView(app, chatOf(ctx));
  await reply(app, ctx, html, kb);
}

async function onSettingsButton(app: App, ctx: Context, field: string): Promise<void> {
  const chatId = chatOf(ctx);
  const msgId = ctx.callbackQuery?.message?.message_id;
  const d = app.chats.ensure(chatId).defaults;
  const show = async (html: string, kb: InlineKeyboard) => {
    if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, html, kb);
  };
  await ctx.answerCallbackQuery();
  if (field === "verbose") {
    app.chats.setDefaults(chatId, { verbose: !d.verbose });
    const v = settingsView(app, chatId);
    await show(v.html, v.kb);
  } else if (field === "model") {
    await show("Default model for new chats:", choiceKeyboard("sdm", modelOptions(app), d.model ?? "default"));
  } else if (field === "mode") {
    await show("Default permission mode for new chats:", choiceKeyboard("sdp", modeOptions(), d.permissionMode));
  } else if (field === "effort") {
    await show("Default effort for new chats:", choiceKeyboard("sde", effortOptions(), d.effort ?? "default"));
  }
}

function onDefaultChoice(field: keyof SessionSettings) {
  return async (app: App, ctx: Context, value: string): Promise<void> => {
    if (field === "permissionMode" && !PERMISSION_MODES.includes(value as never)) return;
    const chatId = chatOf(ctx);
    app.chats.setDefaults(chatId, { [field]: value === "default" ? undefined : value } as Partial<SessionSettings>);
    await ctx.answerCallbackQuery({ text: `${field}: ${value}` });
    const view = settingsView(app, chatId);
    const msgId = ctx.callbackQuery?.message?.message_id;
    if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, view.html, view.kb);
  };
}

// ---- status ------------------------------------------------------------------

async function sessionStatus(app: App, key: ThreadKey): Promise<string[]> {
  const r = app.threads.get(key);
  if (!r) {
    const p = app.projects.activeFor(targetOfKey(key).chatId);
    return [`💬 No session in this chat yet; your first message starts one in <b>${escapeHtml(p.name)}</b>.`];
  }
  const state = app.pool.state(key);
  const usage = await app.pool.contextUsage(key).catch(() => null);
  const lines = [
    `💬 <b>${escapeHtml(truncate(r.title, 80))}</b>`,
    `🆔 <code>${r.sessionId}</code>${r.started ? "" : " (not started)"}`,
    `📁 ${escapeHtml(r.project)} · <code>${escapeHtml(r.cwd)}</code>`,
    `🧠 ${escapeHtml(r.model ?? "default")} · 🔐 ${r.permissionMode} · 🎚 ${r.effort ?? "default"}${r.verbose ? " · verbose" : ""}`,
    `${STATE_ICON[state]} Process: ${state === "cold" ? "hibernated (resumes on your next message)" : state}`,
  ];
  if (usage) {
    lines.push(`📊 Context ${Math.round(usage.percentage)}% (${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()})`);
  }
  return lines;
}

async function status(app: App, { ctx, key }: CommandInput): Promise<void> {
  const stats = app.pool.stats();
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  const titles = new Map(app.threads.list(chatOf(ctx)).map((t) => [t.key, t.record.title]));
  const live = stats.entries.map((e) => {
    const extra = e.blocked ? " · waiting for you" : e.backgroundTasks ? ` · ${e.backgroundTasks} background task(s)` : "";
    return `   ${STATE_ICON[e.state]} ${escapeHtml(truncate(titles.get(e.key) ?? e.key, 50))} — ${e.state}${extra}`;
  });
  const bot = [
    `<b>Bot</b> @${escapeHtml(app.botInfo.username)} · up ${relTime(app.startedAt).replace(" ago", "")}`,
    `🧩 Claude Code ${escapeHtml(app.catalog.version ?? "?")} · Threaded Mode ${app.botInfo.hasTopics ? "on" : "OFF"}`,
    `⚙️ Live ${stats.live}/${stats.max}${stats.waiting ? ` · ${stats.waiting} waiting` : ""} · idle timeout ${Math.round(app.cfg.sessionIdleMs / 60_000)}m`,
    ...live,
    `💾 RAM free ${gb(os.freemem())} / ${gb(os.totalmem())} GB`,
  ];
  const parts = key ? [...(await sessionStatus(app, key)), "", ...bot] : bot;
  if (!app.botInfo.hasTopics) parts.push("", THREADED_MODE_HINT);
  await reply(app, ctx, parts.join("\n"));
}

// ---- registration --------------------------------------------------------------

export function registerControl(app: App): void {
  app.commands
    .register({ name: "help", group: "bot", description: "How this bot works", run: help })
    .register({ name: "start", group: "bot", description: "How this bot works", hidden: true, run: help })
    .register({ name: "status", group: "bot", description: "This chat's session and the bot's state", run: status })
    .register({ name: "sessions", group: "bot", description: "Chats with a session, and their state", run: sessions })
    .register({ name: "resume", group: "bot", usage: "[all|id]", description: "Continue a past session in this chat", run: resume })
    .register({ name: "projects", group: "bot", description: "List projects and switch the active one", run: projects })
    .register({ name: "project", group: "bot", usage: "add|use|rm …", description: "Manage projects", run: project })
    .register({ name: "settings", group: "bot", description: "Defaults for new chats", run: settings });

  app.callbacks
    .on("pj", onProjectButton)
    .on("rs", onResumeButton)
    .on("go", onGoButton)
    .on("set", onSettingsButton)
    .on("sdm", onDefaultChoice("model"))
    .on("sdp", onDefaultChoice("permissionMode"))
    .on("sde", onDefaultChoice("effort"));
}
