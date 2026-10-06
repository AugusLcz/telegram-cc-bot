import { InlineKeyboard, type Context } from "grammy";
import { StartCancelledError } from "../claude/pool.ts";
import type { UserContent } from "../claude/process.ts";
import {
  EFFORTS,
  PERMISSION_MODES,
  parseThreadKey,
  targetOfKey,
  type Effort,
  type PermissionMode,
  type ThreadKey,
  type ThreadRecord,
} from "../core/types.ts";
import { UserError } from "../domain/errors.ts";
import { escapeHtml, truncate } from "../telegram/format.ts";
import { downloadFile, imageMediaType, saveUpload } from "../telegram/media.ts";
import { editHtml, TopicGoneError } from "../telegram/send.ts";
import { targetOf } from "../telegram/target.ts";
import type { App } from "./context.ts";
import { effortOptions, modeOptions, modelOptions } from "./control.ts";
import { callbackData, type CommandDef, type CommandInput } from "./registry.ts";
import { choiceKeyboard, NO_CHAT_HINT, reply, replyTo, sessionStartLine, tabHeader } from "./views.ts";

/**
 * The chat ↔ session side: input that goes to Claude, and commands that act
 * on the session of the chat they are sent in.
 */

/**
 * This chat's record, created on first use with the name Telegram announced
 * for the chat. Chats used only for bot commands never get one.
 */
export function ensureRecord(app: App, key: ThreadKey): ThreadRecord {
  const existing = app.threads.get(key);
  if (existing) return existing;
  const { chatId, threadId } = parseThreadKey(key);
  const announced = app.topicNames.get(key);
  app.topicNames.delete(key);
  return app.threads.bindTab(chatId, threadId, announced?.name, announced?.implicit ?? true).record;
}

/** Send content to the chat's session without blocking the update pipeline. */
export function startTurn(app: App, key: ThreadKey, content: UserContent, promptText?: string): void {
  const record = ensureRecord(app, key);
  const renderer = app.renderers.get(key);
  renderer.beginTurn();
  // Say where a new session works before its first reply.
  let intro: Promise<unknown> = Promise.resolve();
  if (!record.started && !app.announced.has(key)) {
    app.announced.add(key);
    intro = replyTo(app, targetOfKey(key), sessionStartLine(record)).catch(() => {});
  }
  intro
    .then(() => app.threads.send(key, content, promptText))
    .then(async (outcome) => {
      if (outcome.freshSession) {
        await renderer.notice("ℹ️ The previous transcript of this chat was missing, so it continues in a fresh session.");
      }
    })
    .catch(async (err) => {
      await renderer.endTurn();
      if (err instanceof StartCancelledError) return;
      if (err instanceof TopicGoneError) return app.onTopicGone(key);
      if (err instanceof UserError) return void (await renderer.notice(`⚠️ ${err.message}`).catch(() => {}));
      app.log.error(`send in ${key} failed:`, err);
      await renderer.notice(`❌ ${escapeHtml(truncate(err instanceof Error ? err.message : String(err), 500))}`).catch(() => {});
    });
}

/** Text, photos and documents in a chat. */
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
    const record = ensureRecord(app, key);
    const { data } = await downloadFile(app.api, app.cfg.botToken, doc.file_id, doc.file_size);
    const saved = await saveUpload(record.cwd, doc.file_name ?? "file", data);
    startTurn(app, key, `I uploaded a file: ${saved}${msg.caption ? `\n\n${msg.caption}` : ""}`, msg.caption ?? doc.file_name);
    return;
  }
  await reply(app, ctx, "Unsupported message type here. Send text, a photo or a file.");
}

/** A /command that is not a bot command: hand it to Claude Code (as a chat's first message, it names the chat). */
export function passThrough(app: App, key: ThreadKey, name: string, args: string): void {
  const claudeName = app.catalog.resolve(name) ?? name;
  const text = `/${claudeName}${args ? ` ${args}` : ""}`;
  startTurn(app, key, text, text);
}

// ---- commands ------------------------------------------------------------------

type ChatRun = (app: App, input: CommandInput, key: ThreadKey) => Promise<void>;

/** A command acting on this chat's session (only meaningful inside a chat). */
export function chatCommand(def: Omit<CommandDef<App>, "run" | "group"> & { run: ChatRun }): CommandDef<App> {
  return {
    ...def,
    group: "chat",
    run: async (app, input) => {
      if (!input.key) throw new UserError(NO_CHAT_HINT);
      await def.run(app, input, input.key);
    },
  };
}

/** Interrupt the chat's turn, or cancel its queued message; says which. */
async function stopTurn(app: App, key: ThreadKey): Promise<string> {
  app.broker.cancel(key);
  const unqueued = app.pool.cancelWaiting(key);
  const stopped = await app.pool.interrupt(key);
  if (!stopped) await app.renderers.get(key).endTurn();
  return stopped ? "⏹ Interrupted" : unqueued ? "⏹ Cancelled the queued message" : "Nothing is running";
}

const stop: ChatRun = async (app, { ctx }, key) => {
  await reply(app, ctx, await stopTurn(app, key));
};

const model: ChatRun = async (app, { ctx, args }, key) => {
  const record = ensureRecord(app, key);
  const arg = args.trim();
  if (arg) {
    await app.threads.setModel(key, arg === "default" ? undefined : arg);
    await reply(app, ctx, `🧠 Model for this chat: <code>${escapeHtml(arg)}</code>`);
    return;
  }
  if (app.catalog.models.length === 0) throw new UserError("Model list not loaded yet. Use /model &lt;name&gt;.");
  await reply(app, ctx, `Model for this chat (now <code>${escapeHtml(record.model ?? "default")}</code>):`,
    choiceKeyboard("tm", modelOptions(app), record.model ?? "default"));
};

const mode: ChatRun = async (app, { ctx, args }, key) => {
  const record = ensureRecord(app, key);
  const arg = args.trim();
  if (arg) {
    if (!PERMISSION_MODES.includes(arg as PermissionMode)) throw new UserError(`Modes: ${PERMISSION_MODES.join(", ")}`);
    await app.threads.setPermissionMode(key, arg as PermissionMode);
    await reply(app, ctx, `🔐 Permission mode for this chat: <code>${arg}</code>`);
    return;
  }
  await reply(app, ctx, `Permission mode for this chat (now <code>${record.permissionMode}</code>):`,
    choiceKeyboard("tp", modeOptions(), record.permissionMode));
};

const effort: ChatRun = async (app, { ctx, args }, key) => {
  const record = ensureRecord(app, key);
  const arg = args.trim();
  if (arg) {
    if (arg !== "default" && !EFFORTS.includes(arg as Effort)) throw new UserError(`Effort levels: default, ${EFFORTS.join(", ")}`);
    await app.threads.setEffort(key, arg === "default" ? undefined : (arg as Effort));
    await reply(app, ctx, `🎚 Effort for this chat: <code>${arg}</code>`);
    return;
  }
  await reply(app, ctx, `Effort for this chat (now <code>${record.effort ?? "default"}</code>):`,
    choiceKeyboard("tf", effortOptions(), record.effort ?? "default"));
};

const thinking: ChatRun = async (app, { ctx }, key) => {
  const next = !ensureRecord(app, key).thinking;
  await app.threads.setThinking(key, next);
  await reply(
    app,
    ctx,
    next
      ? "💭 Thinking on: Claude's notes between steps, its thinking summaries and timings"
      : "Thinking off: only Claude's answers",
  );
};

const rename: ChatRun = async (app, { ctx, args }, key) => {
  const title = args.trim();
  ensureRecord(app, key);
  if (!title) {
    const named = await app.threads.renameByClaude(key);
    await reply(app, ctx, `✏️ Claude named this chat <b>${escapeHtml(named)}</b>`);
    return;
  }
  await app.threads.rename(key, title);
  await reply(app, ctx, `✏️ Renamed to <b>${escapeHtml(title)}</b>`);
};

const fork: ChatRun = async (app, { ctx }, key) => {
  const tab = await app.threads.forkTab(key);
  await replyTo(app, targetOfKey(tab.key), tabHeader(tab.record, "forked"));
  await reply(app, ctx, `🍴 Forked into a new chat: <b>${escapeHtml(tab.record.title)}</b>`);
};

const close: ChatRun = async (app, { ctx }, key) => {
  const wasLive = app.pool.state(key) !== "cold";
  app.renderers.dispose(key);
  app.broker.cancel(key);
  await app.threads.closeTab(key);
  await reply(app, ctx, wasLive ? "💤 Hibernated. Send a message to pick it up again." : "Nothing is running in this chat.");
};

const del: ChatRun = async (app, { ctx }, key) => {
  const { threadId } = parseThreadKey(key);
  const kb = new InlineKeyboard()
    .text("🗑 Delete chat", callbackData("del", threadId))
    .text("Cancel", callbackData("delx", threadId));
  await reply(
    app,
    ctx,
    "Delete this chat and all its messages? The Claude session itself stays on disk and can be reopened with /resume.",
    kb,
  );
};

// ---- callbacks -----------------------------------------------------------------

/** The chat a button was pressed in. */
export function chatKey(ctx: Context): ThreadKey {
  const t = targetOf(ctx);
  if (!t?.threadId) throw new UserError(NO_CHAT_HINT);
  return `${t.chatId}:${t.threadId}`;
}

async function settle(app: App, ctx: Context, text: string): Promise<void> {
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (msgId) await editHtml(app.api, targetOf(ctx)!, msgId, text);
}

export function registerThread(app: App): void {
  app.commands
    .register(chatCommand({ name: "stop", description: "Interrupt the running turn", run: stop }))
    .register(chatCommand({ name: "model", usage: "[name]", description: "Model for this chat", run: model }))
    .register(chatCommand({ name: "mode", usage: "[mode]", description: "Permission mode for this chat", run: mode }))
    .register(chatCommand({ name: "effort", usage: "[level]", description: "Effort for this chat", run: effort }))
    .register(
      chatCommand({ name: "thinking", aliases: ["verbose"], description: "Show Claude's notes and thinking in this chat", run: thinking }),
    )
    .register(
      chatCommand({ name: "rename", usage: "[title]", description: "Rename this chat (no title: Claude names it)", run: rename }),
    )
    .register(chatCommand({ name: "fork", aliases: ["branch"], description: "Copy this session into a new chat", run: fork }))
    .register(chatCommand({ name: "close", description: "Hibernate now (resumes on next message)", run: close }))
    .register(chatCommand({ name: "delete", description: "Delete this chat (session stays resumable)", run: del }));

  app.callbacks
    .on("tm", async (app, ctx, value) => {
      const key = chatKey(ctx);
      ensureRecord(app, key);
      await app.threads.setModel(key, value === "default" ? undefined : value);
      await ctx.answerCallbackQuery({ text: `Model: ${value}` });
      await settle(app, ctx, `🧠 Model for this chat: <code>${escapeHtml(value)}</code>`);
    })
    .on("tp", async (app, ctx, value) => {
      if (!PERMISSION_MODES.includes(value as PermissionMode)) return;
      const key = chatKey(ctx);
      ensureRecord(app, key);
      await app.threads.setPermissionMode(key, value as PermissionMode);
      await ctx.answerCallbackQuery({ text: `Mode: ${value}` });
      await settle(app, ctx, `🔐 Permission mode for this chat: <code>${value}</code>`);
    })
    .on("tf", async (app, ctx, value) => {
      const key = chatKey(ctx);
      ensureRecord(app, key);
      await app.threads.setEffort(key, value === "default" ? undefined : (value as Effort));
      await ctx.answerCallbackQuery({ text: `Effort: ${value}` });
      await settle(app, ctx, `🎚 Effort for this chat: <code>${value}</code>`);
    })
    .on("del", async (app, ctx) => {
      const key = chatKey(ctx);
      await ctx.answerCallbackQuery({ text: "Deleting…" });
      app.renderers.dispose(key);
      app.broker.cancel(key);
      app.announced.delete(key);
      await app.threads.deleteTab(key);
    })
    .on("delx", async (app, ctx) => {
      await ctx.answerCallbackQuery();
      await settle(app, ctx, "Kept.");
    })
    .on("stop", async (app, ctx) => {
      // The Stop button of the working message, which goes away with the turn.
      await ctx.answerCallbackQuery({ text: await stopTurn(app, chatKey(ctx)) });
    });
}
