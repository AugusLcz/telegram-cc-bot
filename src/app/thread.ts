import { InlineKeyboard, type Context } from "grammy";
import { StartCancelledError } from "../claude/pool.ts";
import type { UserContent } from "../claude/process.ts";
import { EFFORTS, PERMISSION_MODES, parseThreadKey, targetOfKey, type Effort, type PermissionMode, type ThreadKey } from "../core/types.ts";
import { UserError } from "../domain/errors.ts";
import { escapeHtml, truncate } from "../telegram/format.ts";
import { downloadFile, imageMediaType, saveUpload } from "../telegram/media.ts";
import { editHtml, TopicGoneError } from "../telegram/send.ts";
import { targetOf } from "../telegram/target.ts";
import type { App } from "./context.ts";
import { effortOptions, modeOptions, modelOptions } from "./main.ts";
import { callbackData, type CommandInput } from "./registry.ts";
import { choiceKeyboard, reply, replyTo, STATE_ICON, tabHeader } from "./views.ts";

function keyOrThrow(input: { key?: ThreadKey }): ThreadKey {
  if (!input.key) throw new UserError("Open a session tab first (/new).");
  return input.key;
}

/** Make sure a tab the bot has not seen yet is bound to a session (posts the header once). */
export async function ensureTab(app: App, key: ThreadKey, name?: string, implicitName = false): Promise<void> {
  const { chatId, threadId } = parseThreadKey(key);
  const tab = app.threads.bindTab(chatId, threadId, name, implicitName);
  if (tab.created) await replyTo(app, targetOfKey(key), tabHeader(tab.record, "new"));
}

/** Send content to the tab's session without blocking the update pipeline. */
export function startTurn(app: App, key: ThreadKey, content: UserContent, promptText?: string): void {
  const renderer = app.renderers.get(key);
  renderer.beginTurn();
  app.threads
    .send(key, content, promptText)
    .then(async (outcome) => {
      if (outcome.freshSession) {
        await renderer.notice("ℹ️ The previous transcript of this tab was missing, so it continues in a fresh session.");
      }
    })
    .catch(async (err) => {
      renderer.stopTyping();
      if (err instanceof StartCancelledError) return;
      if (err instanceof TopicGoneError) return app.onTopicGone(key);
      if (err instanceof UserError) return void (await renderer.notice(`⚠️ ${err.message}`).catch(() => {}));
      app.log.error(`send in ${key} failed:`, err);
      await renderer.notice(`❌ ${escapeHtml(truncate(err instanceof Error ? err.message : String(err), 500))}`).catch(() => {});
    });
}

/** Text, photos and documents inside a tab. */
export async function handleThreadInput(app: App, ctx: Context, key: ThreadKey): Promise<void> {
  const msg = ctx.message!;
  if (msg.text !== undefined) {
    if (await app.broker.handleText(key, msg.text)) return;
    startTurn(app, key, msg.text, msg.text);
    return;
  }
  if (msg.photo) {
    const photo = msg.photo.at(-1)!;
    const { data, filePath } = await downloadFile(app.api, app.cfg.botToken, photo.file_id, photo.file_size);
    const caption = msg.caption || "Please take a look at this image.";
    startTurn(
      app,
      key,
      [
        { type: "image", source: { type: "base64", media_type: imageMediaType(filePath), data: data.toString("base64") } },
        { type: "text", text: caption },
      ],
      msg.caption,
    );
    return;
  }
  if (msg.document) {
    const doc = msg.document;
    const record = app.threads.require(key);
    const { data } = await downloadFile(app.api, app.cfg.botToken, doc.file_id, doc.file_size);
    const saved = await saveUpload(record.cwd, doc.file_name ?? "file", data);
    startTurn(app, key, `I uploaded a file: ${saved}${msg.caption ? `\n\n${msg.caption}` : ""}`, msg.caption);
    return;
  }
  await reply(app, ctx, "Unsupported message type here. Send text, a photo or a file.");
}

/** A /command that is not a bot command: hand it to Claude Code. */
export function passThrough(app: App, key: ThreadKey, name: string, args: string): void {
  const claudeName = app.catalog.resolve(name) ?? name;
  startTurn(app, key, `/${claudeName}${args ? ` ${args}` : ""}`);
}

// ---- commands ------------------------------------------------------------------

async function stop(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  app.broker.cancel(key);
  const unqueued = app.pool.cancelWaiting(key);
  const stopped = await app.pool.interrupt(key);
  if (!stopped) app.renderers.get(key).stopTyping();
  await reply(app, input.ctx, stopped ? "⏹ Interrupted" : unqueued ? "⏹ Cancelled the queued message" : "Nothing is running");
}

async function model(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  const arg = input.args.trim();
  if (arg) {
    await app.threads.setModel(key, arg === "default" ? undefined : arg);
    await reply(app, input.ctx, `🧠 Model for this tab: <code>${escapeHtml(arg)}</code>`);
    return;
  }
  const record = app.threads.require(key);
  if (app.catalog.models.length === 0) throw new UserError("Model list not loaded yet. Use /model &lt;name&gt;.");
  await reply(app, input.ctx, `Model for this tab (now <code>${escapeHtml(record.model ?? "default")}</code>):`,
    choiceKeyboard("tm", modelOptions(app), record.model ?? "default"));
}

async function mode(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  const arg = input.args.trim();
  if (arg) {
    if (!PERMISSION_MODES.includes(arg as PermissionMode)) throw new UserError(`Modes: ${PERMISSION_MODES.join(", ")}`);
    await app.threads.setPermissionMode(key, arg as PermissionMode);
    await reply(app, input.ctx, `🔐 Permission mode for this tab: <code>${arg}</code>`);
    return;
  }
  const record = app.threads.require(key);
  await reply(app, input.ctx, `Permission mode for this tab (now <code>${record.permissionMode}</code>):`,
    choiceKeyboard("tp", modeOptions(), record.permissionMode));
}

async function effort(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  const arg = input.args.trim();
  if (arg) {
    if (arg !== "default" && !EFFORTS.includes(arg as Effort)) throw new UserError(`Effort levels: default, ${EFFORTS.join(", ")}`);
    await app.threads.setEffort(key, arg === "default" ? undefined : (arg as Effort));
    await reply(app, input.ctx, `🎚 Effort for this tab: <code>${arg}</code>`);
    return;
  }
  const record = app.threads.require(key);
  await reply(app, input.ctx, `Effort for this tab (now <code>${record.effort ?? "default"}</code>):`,
    choiceKeyboard("tf", effortOptions(), record.effort ?? "default"));
}

async function verbose(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  const next = !app.threads.require(key).verbose;
  app.threads.setVerbose(key, next);
  await reply(app, input.ctx, next ? "🔊 Verbose on: tool output and timings" : "🔈 Verbose off");
}

async function tabStatus(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  const r = app.threads.require(key);
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
  await reply(app, input.ctx, lines.join("\n"));
}

async function rename(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  const title = input.args.trim();
  if (!title) throw new UserError("Usage: /rename &lt;title&gt;");
  await app.threads.rename(key, title);
  await reply(app, input.ctx, `✏️ Renamed to <b>${escapeHtml(title)}</b>`);
}

async function fork(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  const tab = await app.threads.forkTab(key);
  await replyTo(app, targetOfKey(tab.key), tabHeader(tab.record, "forked"));
  await reply(app, input.ctx, `🍴 Forked into a new tab: <b>${escapeHtml(tab.record.title)}</b>`);
}

async function close(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  app.broker.cancel(key);
  await app.threads.closeTab(key);
  app.renderers.dispose(key);
  await reply(app, input.ctx, "💤 Hibernated. Send a message to pick it up again.");
}

async function del(app: App, input: CommandInput): Promise<void> {
  const key = keyOrThrow(input);
  const { threadId } = parseThreadKey(key);
  const kb = new InlineKeyboard()
    .text("🗑 Delete tab", callbackData("del", threadId))
    .text("Cancel", callbackData("delx", threadId));
  await reply(
    app,
    input.ctx,
    "Delete this tab and all its messages? The Claude session itself stays on disk and can be reopened with /resume.",
    kb,
  );
}

// ---- callbacks -----------------------------------------------------------------

function tabKey(ctx: Context): ThreadKey {
  const t = targetOf(ctx);
  if (!t?.threadId) throw new UserError("This button belongs to a tab.");
  return `${t.chatId}:${t.threadId}`;
}

async function settle(app: App, ctx: Context, text: string): Promise<void> {
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, text);
}

export function registerThread(app: App): void {
  app.commands
    .register({ name: "stop", scope: "thread", description: "Interrupt the running turn", run: stop })
    .register({ name: "model", scope: "thread", usage: "[name]", description: "Model for this tab", run: model })
    .register({ name: "mode", scope: "thread", usage: "[mode]", description: "Permission mode for this tab", run: mode })
    .register({ name: "effort", scope: "thread", usage: "[level]", description: "Effort for this tab", run: effort })
    .register({ name: "verbose", scope: "thread", description: "Toggle tool output for this tab", run: verbose })
    .register({ name: "status", scope: "thread", description: "Bot status (main) · session status (tab)", run: tabStatus })
    .register({ name: "rename", scope: "thread", usage: "<title>", description: "Rename this session and tab", run: rename })
    .register({ name: "fork", scope: "thread", description: "Fork this session into a new tab", run: fork })
    .register({ name: "close", scope: "thread", description: "Hibernate now (resumes on next message)", run: close })
    .register({ name: "delete", scope: "thread", description: "Delete this tab (session stays resumable)", run: del });

  app.callbacks
    .on("tm", async (app, ctx, value) => {
      await app.threads.setModel(tabKey(ctx), value === "default" ? undefined : value);
      await ctx.answerCallbackQuery({ text: `Model: ${value}` });
      await settle(app, ctx, `🧠 Model for this tab: <code>${escapeHtml(value)}</code>`);
    })
    .on("tp", async (app, ctx, value) => {
      if (!PERMISSION_MODES.includes(value as PermissionMode)) return;
      await app.threads.setPermissionMode(tabKey(ctx), value as PermissionMode);
      await ctx.answerCallbackQuery({ text: `Mode: ${value}` });
      await settle(app, ctx, `🔐 Permission mode for this tab: <code>${value}</code>`);
    })
    .on("tf", async (app, ctx, value) => {
      await app.threads.setEffort(tabKey(ctx), value === "default" ? undefined : (value as Effort));
      await ctx.answerCallbackQuery({ text: `Effort: ${value}` });
      await settle(app, ctx, `🎚 Effort for this tab: <code>${value}</code>`);
    })
    .on("del", async (app, ctx) => {
      const key = tabKey(ctx);
      await ctx.answerCallbackQuery({ text: "Deleting…" });
      app.broker.cancel(key);
      app.renderers.dispose(key);
      await app.threads.deleteTab(key);
    })
    .on("delx", async (app, ctx) => {
      await ctx.answerCallbackQuery();
      await settle(app, ctx, "Kept.");
    });
}
