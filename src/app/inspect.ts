import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerStatus, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { InlineKeyboard, type Context } from "grammy";
import { withProbe } from "../claude/catalog.ts";
import { claudeCli } from "../claude/cli.ts";
import { commandKind, toTelegramName } from "../claude/cmdnames.ts";
import { hooksView, instructionFiles, permissionsView, settingsSources, type SettingsSource } from "../claude/config-files.ts";
import { claudeEnv, type ProcessHandle, type TaskInfo } from "../claude/process.ts";
import type { TranscriptEntry } from "../claude/sessions.ts";
import type { ThreadKey, ThreadRecord } from "../core/types.ts";
import { UserError } from "../domain/errors.ts";
import { escapeHtml, truncate } from "../telegram/format.ts";
import { editHtml, sendFile } from "../telegram/send.ts";
import { targetOf } from "../telegram/target.ts";
import { toolIcon, toolSummary } from "../telegram/tools.ts";
import type { App } from "./context.ts";
import { callbackData, type CommandInput } from "./registry.ts";
import { chatCommand, chatKey, ensureRecord, startTurn } from "./thread.ts";
import { relTime, reply } from "./views.ts";

/**
 * Commands that show (and for MCP servers, plugins and tasks, manage) what a
 * chat's Claude Code session has: Telegram versions of Claude Code's terminal
 * screens (/skills, /mcp, /tasks, /diff …). None of them talk to Claude.
 */

type Run = (app: App, input: CommandInput) => Promise<void>;

const MESSAGE_LIMIT = 3800;

/** Where this chat's session works: its record, else the active project. Creates no record. */
function chatCwd(app: App, input: CommandInput): string {
  const record = input.key ? app.threads.get(input.key) : undefined;
  return record?.cwd ?? app.projects.activeFor(input.target.chatId).path;
}

/**
 * Ask this chat's running Claude Code process, or, when none runs, a throwaway
 * one in the chat's directory (no message, no transcript, no pool slot).
 */
async function inspect<T>(app: App, input: CommandInput, fn: (h: ProcessHandle) => Promise<T>): Promise<T> {
  const live = input.key ? app.pool.get(input.key) : undefined;
  if (live) return fn(live);
  const record = input.key ? app.threads.get(input.key) : undefined;
  const mode = record?.permissionMode ?? app.chats.ensure(input.target.chatId).defaults.permissionMode;
  return withProbe(app.factory, chatCwd(app, input), mode, fn, app.log);
}

/** Send lines as few messages as fit; the keyboard goes on the last one. */
async function replyLines(app: App, ctx: Context, lines: string[], keyboard?: InlineKeyboard): Promise<void> {
  const messages: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > MESSAGE_LIMIT) {
      messages.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) messages.push(cur);
  for (let i = 0; i < messages.length; i++) await reply(app, ctx, messages[i], i === messages.length - 1 ? keyboard : undefined);
}

const code = (s: string) => `<code>${escapeHtml(s)}</code>`;
const oneLine = (s: string, limit: number) => escapeHtml(truncate(s.replace(/\s+/g, " ").trim(), limit));

// ---- /skills, /agents ------------------------------------------------------------

/** One row per name; a row Claude Code marks as its own wins, as it does when running /name. */
function uniqueCommands(cmds: SlashCommand[]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const c of cmds) if (!byName.has(c.name) || c.builtin) byName.set(c.name, c);
  return [...byName.values()];
}

function skillLine(c: SlashCommand, botNames: ReadonlySet<string>): string {
  const tg = toTelegramName(c.name);
  // Tappable when Telegram can link it and it doesn't land on a bot command of the same spelling.
  const name = tg && !botNames.has(tg) ? `/${tg}` : code(`/${c.name}`);
  const hint = c.argumentHint ? ` <i>${escapeHtml(c.argumentHint)}</i>` : "";
  return `${name}${hint}${c.description ? ` — ${oneLine(c.description, 140)}` : ""}`;
}

const skills: Run = async (app, input) => {
  const cmds = uniqueCommands(await inspect(app, input, (h) => h.supportedCommands()));
  app.catalog.learn(cmds.map((c) => c.name));
  const botNames = app.commands.names();
  const own = cmds.filter((c) => commandKind(c, botNames) === "own-skill");
  const bundled = cmds.filter((c) => commandKind(c, botNames) === "skill");
  const lines = [`<b>Skills</b> · ${code(chatCwd(app, input))}`, "Tap one to run it, or type it with arguments.", "", "<b>Yours</b> (user, project, plugins)"];
  lines.push(...(own.length ? own.map((c) => skillLine(c, botNames)) : ["None yet. Add one as ~/.claude/skills/&lt;name&gt;/SKILL.md, or in the project's .claude/skills/."]));
  if (bundled.length) lines.push("", "<b>Claude Code</b>", ...bundled.map((c) => skillLine(c, botNames)));
  await replyLines(app, input.ctx, lines);
};

const agents: Run = async (app, input) => {
  const list = await inspect(app, input, (h) => h.supportedAgents());
  const lines = [`<b>Subagents</b> · ${code(chatCwd(app, input))}`, ""];
  for (const a of list) {
    lines.push(`🤖 <b>${escapeHtml(a.name)}</b>${a.model ? ` · ${code(a.model)}` : ""}`, `    ${oneLine(a.description, 200)}`);
  }
  if (!list.length) lines.push("None available.");
  lines.push(
    "",
    "Claude picks one by its description; you can also ask for it by name (“use the X agent to …”). " +
      "Add your own as Markdown files in ~/.claude/agents/ or the project's .claude/agents/.",
  );
  await replyLines(app, input.ctx, lines);
};

// ---- /mcp ------------------------------------------------------------------------

const MCP_ICON: Record<McpServerStatus["status"], string> = {
  connected: "🟢",
  failed: "🔴",
  "needs-auth": "🔑",
  pending: "⏳",
  disabled: "⏸",
};

/** Server names behind the buttons of the last /mcp list, per chat (callback data is limited to 64 bytes). */
const mcpShown = new Map<ThreadKey, string[]>();

/** The chat's own session process: MCP changes apply to it. */
async function sessionProcess(app: App, key: ThreadKey): Promise<ProcessHandle> {
  ensureRecord(app, key);
  return app.pool.ensure(key, () => app.threads.specFor(key));
}

function mcpView(key: ThreadKey, servers: McpServerStatus[]): { html: string; kb?: InlineKeyboard } {
  mcpShown.set(key, servers.map((s) => s.name));
  if (!servers.length) {
    return { html: "No MCP servers in this chat's session. Add one on the server with <code>claude mcp add …</code>, then /mcp again." };
  }
  const kb = new InlineKeyboard();
  const lines = ["<b>MCP servers</b> of this chat's session", ""];
  servers.forEach((s, i) => {
    const tools = s.tools?.length ? ` · ${s.tools.length} tools` : "";
    lines.push(`${MCP_ICON[s.status] ?? "•"} <b>${escapeHtml(s.name)}</b> · ${s.status}${s.scope ? ` · ${escapeHtml(s.scope)}` : ""}${tools}`);
    if (s.error) lines.push(`    ${oneLine(s.error, 200)}`);
    kb.text(truncate(`🔄 ${s.name}`, 30), callbackData("mcp", `r:${i}`));
    kb.text(s.status === "disabled" ? "▶ Enable" : "⏸ Disable", callbackData("mcp", `${s.status === "disabled" ? "e" : "d"}:${i}`)).row();
  });
  if (servers.some((s) => s.status === "needs-auth")) {
    lines.push("", "🔑 Sign-in needed: run <code>claude</code> on the server and use /mcp there; claude.ai connectors are authorized in claude.ai's settings.");
  }
  return { html: lines.join("\n"), kb };
}

const MCP_USAGE = "Usage: /mcp · /mcp reconnect &lt;server|all&gt; · /mcp enable|disable &lt;server|all&gt;";

async function mcpAct(h: ProcessHandle, action: string, name: string): Promise<void> {
  const names = name === "all" ? (await h.mcpServerStatus()).map((s) => s.name) : [name];
  for (const n of names) {
    if (action === "reconnect") await h.reconnectMcpServer(n);
    else await h.toggleMcpServer(n, action === "enable");
  }
}

const mcp = chatCommand({
  name: "mcp",
  usage: "[reconnect|enable|disable <server|all>]",
  description: "MCP servers of this session",
  run: async (app, input, key) => {
    const [action, ...rest] = input.args.trim().split(/\s+/).filter(Boolean);
    const h = await sessionProcess(app, key);
    if (action) {
      if (!["reconnect", "enable", "disable"].includes(action) || !rest.length) throw new UserError(MCP_USAGE);
      await mcpAct(h, action, rest.join(" "));
    }
    const { html, kb } = mcpView(key, await h.mcpServerStatus());
    await reply(app, input.ctx, html, kb);
  },
});

async function onMcpButton(app: App, ctx: Context, payload: string): Promise<void> {
  const key = chatKey(ctx);
  const [act, index] = payload.split(":");
  const name = mcpShown.get(key)?.[Number(index)];
  if (!name) return void (await ctx.answerCallbackQuery({ text: "This list is outdated; send /mcp again." }));
  const action = act === "r" ? "reconnect" : act === "e" ? "enable" : "disable";
  const h = await sessionProcess(app, key);
  await mcpAct(h, action, name);
  await ctx.answerCallbackQuery({ text: `${name}: ${action === "reconnect" ? "reconnecting" : `${action}d`}` });
  const { html, kb } = mcpView(key, await h.mcpServerStatus());
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, html, kb);
}

// ---- /tasks ----------------------------------------------------------------------

const tasksShown = new Map<ThreadKey, string[]>();

function tasksView(key: ThreadKey, tasks: readonly TaskInfo[]): { html: string; kb?: InlineKeyboard } {
  tasksShown.set(key, tasks.map((t) => t.id));
  if (!tasks.length) return { html: "No background tasks running in this chat." };
  const kb = new InlineKeyboard();
  const lines = ["<b>Background tasks</b> of this chat", ""];
  tasks.forEach((t, i) => {
    lines.push(`⚙️ <b>${escapeHtml(t.type)}</b> · ${oneLine(t.description, 160)} · started ${relTime(t.since)}`);
    kb.text(truncate(`⏹ Stop ${t.description}`, 40), callbackData("tk", i)).row();
  });
  return { html: lines.join("\n"), kb };
}

const tasks = chatCommand({
  name: "tasks",
  aliases: ["bashes"],
  description: "Background tasks of this session",
  run: async (app, input, key) => {
    const { html, kb } = tasksView(key, app.pool.get(key)?.tasks ?? []);
    await reply(app, input.ctx, html, kb);
  },
});

async function onTaskButton(app: App, ctx: Context, payload: string): Promise<void> {
  const key = chatKey(ctx);
  const id = tasksShown.get(key)?.[Number(payload)];
  const h = app.pool.get(key);
  if (!id || !h || !h.tasks.some((t) => t.id === id)) {
    return void (await ctx.answerCallbackQuery({ text: "That task is no longer running." }));
  }
  await h.stopTask(id);
  await ctx.answerCallbackQuery({ text: "Stopping…" });
  const { html, kb } = tasksView(key, h.tasks.filter((t) => t.id !== id));
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, html, kb);
}

// ---- /diff, /export --------------------------------------------------------------

const PATCH_LIMIT = 5 * 1024 * 1024;

const diff: Run = async (app, input) => {
  const cwd = chatCwd(app, input);
  const env = { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const git = (args: string[], maxBytes?: number) =>
    app.exec("git", ["-c", "core.quotePath=false", "-C", cwd, ...args], { env, timeoutMs: 15_000, maxBytes });
  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code === 127) throw new UserError("git is not installed on the server.");
  if (inside.code !== 0) return void (await reply(app, input.ctx, `${code(cwd)} is not a git repository.`));
  const status = (await git(["status", "--short", "--branch"])).stdout.trimEnd();
  const hasHead = (await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
  const base = hasHead ? ["diff", "HEAD", "--no-color"] : ["diff", "--no-color"];
  const stat = (await git([...base, "--stat"])).stdout.trimEnd();
  const lines = [`<b>git</b> · ${code(cwd)}`, `<pre>${escapeHtml(truncate(status, 1500))}</pre>`];
  if (stat) lines.push(`<pre>${escapeHtml(truncate(stat, 1500))}</pre>`);
  else if (!status.includes("\n")) lines.push("✨ No changes.");
  await reply(app, input.ctx, lines.join("\n"));
  if (!stat) return;
  const full = await git(base, PATCH_LIMIT);
  if (full.stdout.trim()) {
    const caption = full.truncated ? "Cut at 5 MB" : `git ${base.filter((a) => a !== "--no-color").join(" ")}`;
    await sendFile(app.api, input.target, "changes.patch", full.stdout, caption);
  }
};

/** The conversation as Markdown: text in full, tool calls as one line each, tool results left out. */
export function transcriptMarkdown(record: ThreadRecord, entries: TranscriptEntry[], now = new Date()): string {
  const out = [`# ${record.title}`, "", `Session \`${record.sessionId}\` · \`${record.cwd}\` · exported ${now.toISOString()}`];
  let role: string | undefined;
  for (const e of entries) {
    if (e.role !== role) {
      out.push("", e.role === "user" ? "## You" : "## Claude");
      role = e.role;
    }
    if (e.text) out.push("", e.text);
    if (e.tools.length) out.push("", ...e.tools.map((t) => `> ${toolIcon(t.name)} ${t.name}: ${toolSummary(t.name, t.input)}`));
  }
  return out.join("\n") + "\n";
}

const exportChat = chatCommand({
  name: "export",
  description: "This conversation as a Markdown file",
  run: async (app, input, key) => {
    const record = app.threads.get(key);
    if (!record?.started) throw new UserError("Nothing to export yet: this chat has no conversation.");
    const entries = await app.sessions.transcript(record.sessionId, record.cwd);
    const name = record.title.replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim().slice(0, 60) || "session";
    await sendFile(app.api, input.target, `${name}.md`, transcriptMarkdown(record, entries), `${entries.length} messages`);
  },
});

// ---- /plan -----------------------------------------------------------------------

const plan = chatCommand({
  name: "plan",
  usage: "[task]",
  description: "Plan mode for this chat (optionally with a task)",
  run: async (app, input, key) => {
    ensureRecord(app, key);
    await app.threads.setPermissionMode(key, "plan");
    await reply(app, input.ctx, "📝 Plan mode on: Claude explores and proposes a plan before changing anything. /mode switches back.");
    const task = input.args.trim();
    if (task) startTurn(app, key, task, task);
  },
});

// ---- /memory, /permissions, /hooks ---------------------------------------------------

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

const memory: Run = async (app, input) => {
  const cwd = chatCwd(app, input);
  const files = instructionFiles(os.homedir(), cwd);
  const arg = input.args.trim();
  if (arg) {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > files.length) throw new UserError(`Usage: /memory, or /memory &lt;1-${files.length || 1}&gt;`);
    const f = files[n - 1];
    await sendFile(app.api, input.target, path.basename(f.path), fs.readFileSync(f.path), f.path);
    return;
  }
  if (!files.length) return void (await reply(app, input.ctx, `No CLAUDE.md or AGENTS.md is loaded in ${code(cwd)}.`));
  await replyLines(app, input.ctx, [
    `<b>Instruction files</b> a session in ${code(cwd)} loads`,
    "",
    ...files.map((f, i) => `${i + 1}. ${code(f.path)} · ${f.scope} · ${size(f.bytes)}`),
    "",
    "/memory &lt;n&gt; sends one. To change them, ask Claude (e.g. “add to CLAUDE.md: …”).",
  ]);
};

const sourceLine = (s: SettingsSource) => `<b>${s.scope}</b> · ${code(s.path)}`;
const ruleList = (icon: string, label: string, rules: string[]) =>
  rules.length ? [`${icon} ${label}: ${rules.map((r) => code(r)).join(", ")}`] : [];

const permissions: Run = async (app, input) => {
  const cwd = chatCwd(app, input);
  const views = permissionsView(settingsSources(os.homedir(), cwd));
  const record = input.key ? app.threads.get(input.key) : undefined;
  const lines = [`<b>Permission rules</b> for ${code(cwd)} (highest precedence first)`];
  if (record) lines.push(`This chat runs in ${code(record.permissionMode)} mode (/mode).`);
  for (const v of views) {
    lines.push(
      "",
      sourceLine(v.source),
      ...(v.defaultMode ? [`default mode: ${code(v.defaultMode)}`] : []),
      ...ruleList("✅", "allow", v.allow),
      ...ruleList("❓", "ask", v.ask),
      ...ruleList("⛔", "deny", v.deny),
      ...ruleList("📂", "extra directories", v.additionalDirectories),
    );
  }
  if (!views.length) lines.push("", "No rules in the managed, user, project or local settings.");
  lines.push("", "To change them, ask Claude, or edit the settings file on the server.");
  await replyLines(app, input.ctx, lines);
};

const hooks: Run = async (app, input) => {
  const cwd = chatCwd(app, input);
  const list = hooksView(settingsSources(os.homedir(), cwd));
  const lines = [`<b>Hooks</b> for ${code(cwd)}`];
  let last: SettingsSource | undefined;
  for (const h of list) {
    if (h.source !== last) lines.push("", sourceLine(h.source));
    last = h.source;
    lines.push(`• <b>${escapeHtml(h.event)}</b> ${code(h.matcher)} → ${h.commands.map((c) => code(truncate(c, 120))).join(", ")}`);
  }
  if (!list.length) lines.push("", "No hooks in the managed, user, project or local settings.");
  lines.push("", "Plugins can add hooks of their own; they are not listed here.");
  await replyLines(app, input.ctx, lines);
};

// ---- /plugin ---------------------------------------------------------------------

const PLUGIN_USAGE =
  "Usage: /plugin [list] · /plugin install &lt;name@marketplace&gt; · /plugin uninstall|enable|disable|update &lt;name&gt; · " +
  "/plugin marketplace list|add &lt;source&gt;|update [name]|remove &lt;name&gt;";

/** Which `claude plugin` invocations the bot runs; true when they change plugins. */
function pluginCommand(args: string[]): { changes: boolean } | undefined {
  const [sub, ...rest] = args;
  if (sub === "list") return rest.length ? undefined : { changes: false };
  if (["install", "uninstall", "enable", "disable", "update"].includes(sub)) return rest.length ? { changes: true } : undefined;
  if (sub === "marketplace") {
    const [action, ...more] = rest;
    if (action === "list") return { changes: false };
    if (action === "update") return { changes: true };
    if ((action === "add" || action === "remove") && more.length) return { changes: true };
  }
  return undefined;
}

const plugin: Run = async (app, input) => {
  const args = input.args.trim().split(/\s+/).filter(Boolean);
  if (!args.length) args.push("list");
  const kind = pluginCommand(args);
  if (!kind) throw new UserError(PLUGIN_USAGE);
  const cli = claudeCli(app.cfg.claudePath);
  if (!cli) throw new UserError("Claude Code's CLI was not found on the server.");
  const res = await app.exec(cli, ["plugin", ...args], {
    cwd: chatCwd(app, input),
    env: { ...claudeEnv(), DISABLE_AUTOUPDATER: "1" },
    timeoutMs: 120_000,
  });
  const out = `${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`.trim() || "(no output)";
  let note = "";
  if (res.code === 0 && kind.changes) {
    const live = input.key ? app.pool.get(input.key) : undefined;
    if (live) {
      await live.reloadPlugins().catch((err) => app.log.warn("reloading plugins failed:", err));
      note = "Reloaded in this chat's session; other chats load it when their session next starts.";
    } else {
      note = "Chats load it when their session next starts.";
    }
  }
  const head = `${res.code === 0 ? "🧩" : "⚠️"} ${code(`claude plugin ${args.join(" ")}`)}`;
  if (out.length > 3000) {
    await reply(app, input.ctx, [head, note].filter(Boolean).join("\n"));
    await sendFile(app.api, input.target, "plugin.txt", out);
    return;
  }
  await reply(app, input.ctx, [head, `<pre>${escapeHtml(out)}</pre>`, note].filter(Boolean).join("\n"));
};

// ---- registration ----------------------------------------------------------------

export function registerInspect(app: App): void {
  app.commands
    .register({ name: "skills", group: "chat", description: "Skills you can run in this chat", run: skills })
    .register({ name: "agents", group: "chat", description: "Subagents Claude can use here", run: agents })
    .register(mcp)
    .register(tasks)
    .register({ name: "diff", group: "chat", description: "Uncommitted git changes in this chat's directory", run: diff })
    .register(exportChat)
    .register(plan)
    .register({ name: "memory", group: "chat", usage: "[n]", description: "CLAUDE.md / AGENTS.md files loaded here", run: memory })
    .register({ name: "permissions", group: "chat", description: "Permission rules from the settings files", run: permissions })
    .register({ name: "hooks", group: "chat", description: "Hooks from the settings files", run: hooks })
    .register({ name: "plugin", group: "bot", usage: "[list|install|…]", description: "List, install or remove plugins", run: plugin });

  app.callbacks.on("mcp", onMcpButton).on("tk", onTaskButton);
}
