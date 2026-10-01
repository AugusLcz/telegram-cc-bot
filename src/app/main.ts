import os from "node:os";
import { InlineKeyboard, type Context } from "grammy";
import { sessionTitle } from "../claude/sessions.ts";
import { EFFORTS, PERMISSION_MODES, targetOfKey, type SessionSettings } from "../core/types.ts";
import { UserError } from "../domain/errors.ts";
import { escapeHtml, truncate } from "../telegram/format.ts";
import { editHtml } from "../telegram/send.ts";
import { targetOf } from "../telegram/target.ts";
import type { App } from "./context.ts";
import { callbackData, type CommandInput } from "./registry.ts";
import { choiceKeyboard, relTime, reply, replyTo, STATE_ICON, tabHeader, THREADED_MODE_HINT } from "./views.ts";

const UUID_PREFIX = /^[0-9a-f]{8}(-[0-9a-f-]{1,28})?$/i;

function chatOf(ctx: Context): number {
  return ctx.chat!.id;
}

function requireTabs(app: App): void {
  if (!app.botInfo.hasTopics) throw new UserError(THREADED_MODE_HINT);
}

// ---- help --------------------------------------------------------------------

async function help(app: App, { ctx, key }: CommandInput): Promise<void> {
  const place = key ? "thread" : "main";
  const lines = app.commands
    .list(place)
    .filter((d) => d.name !== "start")
    .map((d) => `/${d.name}${d.usage ? ` ${escapeHtml(d.usage)}` : ""} — ${escapeHtml(d.description)}`);
  let html: string;
  if (place === "main") {
    const project = app.projects.activeFor(chatOf(ctx));
    html =
      `<b>Control panel</b>\nActive project: <b>${escapeHtml(project.name)}</b> · <code>${escapeHtml(project.path)}</code>\n\n` +
      `Each tab is a Claude Code session in the project that was active when it was opened. ` +
      `Open one with /new${app.botInfo.usersCreateTopics ? " or the + button" : ""}.\n\n${lines.join("\n")}`;
    if (!app.botInfo.hasTopics) html += `\n\n${THREADED_MODE_HINT}`;
  } else {
    html =
      `<b>Session tab</b>\nMessages, photos and files go to Claude. Any other /command goes to Claude Code ` +
      `(for example /compact, /context, /usage, /clear and your skills).\n\n${lines.join("\n")}`;
  }
  await reply(app, ctx, html);
}

// ---- projects ------------------------------------------------------------------

function projectList(app: App, chatId: number): { html: string; kb: InlineKeyboard } {
  const active = app.projects.activeFor(chatId);
  const projects = app.projects.list();
  const lines = projects.map(
    (p) => `${p.name === active.name ? "▶" : "•"} <b>${escapeHtml(p.name)}</b> · <code>${escapeHtml(p.path)}</code>`,
  );
  const html =
    `<b>Projects</b> (new tabs open in the ▶ one)\n\n${lines.join("\n")}\n\n` +
    `/project add &lt;name&gt; &lt;path&gt; · /project use &lt;name&gt; · /project rm &lt;name&gt;`;
  return { html, kb: choiceKeyboard("pj", projects.map((p) => ({ label: p.name, value: p.name })), active.name) };
}

async function projects(app: App, { ctx }: CommandInput): Promise<void> {
  const { html, kb } = projectList(app, chatOf(ctx));
  await reply(app, ctx, html, kb);
}

async function project(app: App, input: CommandInput): Promise<void> {
  const { ctx, args } = input;
  const [sub = "", name = "", ...rest] = args.split(/\s+/).filter(Boolean);
  const chatId = chatOf(ctx);
  switch (sub) {
    case "add": {
      const rawPath = args.replace(/^\s*add\s+\S+\s*/, "");
      if (!name || !rawPath) throw new UserError("Usage: /project add &lt;name&gt; &lt;path&gt;");
      const p = app.projects.add(name, rawPath);
      app.projects.use(chatId, p.name);
      await reply(app, ctx, `✅ Added <b>${escapeHtml(p.name)}</b> · <code>${escapeHtml(p.path)}</code>\nIt is now the active project.`);
      return;
    }
    case "use": {
      if (!name) throw new UserError("Usage: /project use &lt;name&gt;");
      const p = app.projects.use(chatId, name);
      await reply(app, ctx, `▶ Active project: <b>${escapeHtml(p.name)}</b>. New tabs open there.`);
      return;
    }
    case "rm":
    case "remove": {
      if (!name) throw new UserError("Usage: /project rm &lt;name&gt;");
      app.projects.remove(name);
      await reply(app, ctx, `🗑 Removed <b>${escapeHtml(name)}</b>. Tabs that use it keep working.`);
      return;
    }
    default:
      if (sub || rest.length) throw new UserError("Usage: /project add|use|rm …");
      await projects(app, input);
  }
}

async function onProjectButton(app: App, ctx: Context, name: string): Promise<void> {
  const chatId = chatOf(ctx);
  app.projects.use(chatId, name);
  await ctx.answerCallbackQuery({ text: `Active project: ${name}` });
  const { html, kb } = projectList(app, chatId);
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, html, kb);
}

// ---- tabs --------------------------------------------------------------------

async function newTab(app: App, { ctx, args }: CommandInput): Promise<void> {
  requireTabs(app);
  const tab = await app.threads.createTab(chatOf(ctx), args);
  await replyTo(app, targetOfKey(tab.key), tabHeader(tab.record, "new"));
  await reply(app, ctx, `🆕 Opened <b>${escapeHtml(tab.record.title)}</b> in <b>${escapeHtml(tab.record.project)}</b>. Switch to the new tab to start.`);
}

async function openResumed(app: App, ctx: Context, sessionId: string): Promise<string> {
  requireTabs(app);
  const tab = await app.threads.resumeIntoTab(chatOf(ctx), sessionId);
  const target = targetOfKey(tab.key);
  if (tab.existed) {
    await replyTo(app, target, "👋 This session is open here.");
    return `Already open in tab "${tab.record.title}"`;
  }
  const recap = await app.sessions.recap(tab.record.sessionId, tab.record.cwd).catch(() => undefined);
  await replyTo(app, target, tabHeader(tab.record, "resumed", recap));
  return `Opened "${tab.record.title}" in a new tab`;
}

async function resume(app: App, { ctx, args }: CommandInput): Promise<void> {
  const arg = args.trim();
  if (arg && arg !== "all") {
    if (!UUID_PREFIX.test(arg)) throw new UserError("Usage: /resume, /resume all or /resume &lt;session-id&gt;");
    const text = await openResumed(app, ctx, arg);
    await reply(app, ctx, `▶️ ${escapeHtml(text)}`);
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
  await reply(app, ctx, `Resume a session from ${scope} (📌 already has a tab):\n\n${lines.join("\n")}`, kb);
}

async function onResumeButton(app: App, ctx: Context, sessionId: string): Promise<void> {
  const text = await openResumed(app, ctx, sessionId);
  await ctx.answerCallbackQuery({ text: truncate(text, 190) });
}

async function sessions(app: App, { ctx }: CommandInput): Promise<void> {
  const tabs = app.threads.list(chatOf(ctx));
  const stats = app.pool.stats();
  const head = `<b>Sessions</b> · live ${stats.live}/${stats.max}${stats.waiting ? ` · ${stats.waiting} waiting` : ""}`;
  if (tabs.length === 0) {
    await reply(app, ctx, `${head}\n\nNo tabs yet. Open one with /new.`);
    return;
  }
  const kb = new InlineKeyboard();
  const lines = tabs.map(({ key, record }, i) => {
    if (i < 10) kb.text(truncate(`${STATE_ICON[app.pool.state(key)]} ${record.title}`, 48), callbackData("go", record.threadId)).row();
    return `${STATE_ICON[app.pool.state(key)]} <b>${escapeHtml(truncate(record.title, 60))}</b> · ${escapeHtml(record.project)} · ${relTime(record.lastActiveAt)}`;
  });
  await reply(app, ctx, `${head}\n🟢 busy · 🟡 idle · ⚪ hibernated\n\n${lines.join("\n")}`, kb);
}

async function onGoButton(app: App, ctx: Context, threadId: string): Promise<void> {
  const target = { chatId: chatOf(ctx), threadId: Number(threadId) };
  await replyTo(app, target, "👋 Here.");
  await ctx.answerCallbackQuery({ text: "Posted in the tab" });
}

// ---- settings ----------------------------------------------------------------

function settingsView(app: App, chatId: number): { html: string; kb: InlineKeyboard } {
  const d = app.chats.ensure(chatId).defaults;
  const html =
    `<b>Defaults for new tabs</b>\n` +
    `🧠 Model: <code>${escapeHtml(d.model ?? "default")}</code>\n` +
    `🔐 Permission mode: <code>${d.permissionMode}</code>\n` +
    `🎚 Effort: <code>${d.effort ?? "default"}</code>\n` +
    `🔊 Verbose: ${d.verbose ? "on" : "off"}\n\n` +
    `<i>Existing tabs keep their own settings (/model, /mode, /effort inside a tab).</i>`;
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

export function modelOptions(app: App): { label: string; value: string }[] {
  return [{ label: "Default", value: "default" }, ...app.catalog.models.map((m) => ({ label: m.displayName, value: m.value }))];
}

export const modeOptions = () => PERMISSION_MODES.map((m) => ({ label: m, value: m }));
export const effortOptions = () => [{ label: "Default", value: "default" }, ...EFFORTS.map((e) => ({ label: e, value: e }))];

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
    await show("Default model for new tabs:", choiceKeyboard("sdm", modelOptions(app), d.model ?? "default"));
  } else if (field === "mode") {
    await show("Default permission mode for new tabs:", choiceKeyboard("sdp", modeOptions(), d.permissionMode));
  } else if (field === "effort") {
    await show("Default effort for new tabs:", choiceKeyboard("sde", effortOptions(), d.effort ?? "default"));
  }
}

function onDefaultChoice(field: keyof SessionSettings) {
  return async (app: App, ctx: Context, value: string): Promise<void> => {
    const chatId = chatOf(ctx);
    const v = value === "default" ? undefined : value;
    if (field === "permissionMode" && !PERMISSION_MODES.includes(value as never)) return;
    app.chats.setDefaults(chatId, { [field]: v } as Partial<SessionSettings>);
    await ctx.answerCallbackQuery({ text: `${field}: ${value}` });
    const view = settingsView(app, chatId);
    const msgId = ctx.callbackQuery?.message?.message_id;
    if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, view.html, view.kb);
  };
}

// ---- status ------------------------------------------------------------------

async function status(app: App, { ctx }: CommandInput): Promise<void> {
  const stats = app.pool.stats();
  const up = relTime(app.startedAt).replace(" ago", "");
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  const tabs = new Map(app.threads.list(chatOf(ctx)).map((t) => [t.key, t.record]));
  const live = stats.entries.map((e) => {
    const title = tabs.get(e.key)?.title ?? e.key;
    const extra = e.blocked ? " · waiting for you" : e.backgroundTasks ? ` · ${e.backgroundTasks} background task(s)` : "";
    return `${STATE_ICON[e.state]} ${escapeHtml(truncate(title, 50))} — ${e.state}${extra}`;
  });
  const html = [
    `🤖 @${escapeHtml(app.botInfo.username)} · up ${up}`,
    `🧩 Claude Code ${escapeHtml(app.catalog.version ?? "?")} · tabs ${app.botInfo.hasTopics ? "on" : "OFF"}`,
    `⚙️ Live ${stats.live}/${stats.max}${stats.waiting ? ` · ${stats.waiting} waiting` : ""} · idle timeout ${Math.round(app.cfg.sessionIdleMs / 60_000)}m`,
    ...live,
    `💾 RAM free ${gb(os.freemem())} / ${gb(os.totalmem())} GB`,
    app.botInfo.hasTopics ? "" : `\n${THREADED_MODE_HINT}`,
  ]
    .filter(Boolean)
    .join("\n");
  await reply(app, ctx, html);
}

// ---- registration --------------------------------------------------------------

export function registerMain(app: App): void {
  app.commands
    .register({ name: "help", scope: "both", description: "Help for this view", run: help })
    .register({ name: "start", scope: "both", description: "Help for this view", run: help })
    .register({ name: "new", scope: "both", usage: "[title]", description: "Open a new tab in the active project", run: newTab })
    .register({ name: "resume", scope: "both", usage: "[all|id]", description: "Open a past session in a tab", run: resume })
    .register({ name: "projects", scope: "main", description: "List projects and switch the active one", run: projects })
    .register({ name: "project", scope: "main", usage: "add|use|rm …", description: "Manage projects", run: project })
    .register({ name: "sessions", scope: "main", description: "Tabs and their state", run: sessions })
    .register({ name: "settings", scope: "main", description: "Defaults for new tabs", run: settings })
    .register({ name: "status", scope: "main", description: "Bot status (main) · session status (tab)", run: status });

  app.callbacks
    .on("pj", onProjectButton)
    .on("rs", onResumeButton)
    .on("go", onGoButton)
    .on("set", onSettingsButton)
    .on("sdm", onDefaultChoice("model"))
    .on("sdp", onDefaultChoice("permissionMode"))
    .on("sde", onDefaultChoice("effort"));
}
