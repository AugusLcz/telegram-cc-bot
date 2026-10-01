import { sequentialize } from "@grammyjs/runner";
import type { Bot, Context, NextFunction } from "grammy";
import { CommandCatalog } from "../claude/catalog.ts";
import { CommandNameMap, parseCommand } from "../claude/cmdnames.ts";
import { SessionPool } from "../claude/pool.ts";
import type { ProcessFactory } from "../claude/process.ts";
import type { SessionApi } from "../claude/sessions.ts";
import type { Config } from "../core/config.ts";
import type { Logger } from "../core/logger.ts";
import { targetOfKey, type ThreadKey } from "../core/types.ts";
import { AccessControl } from "../domain/access.ts";
import { ChatService } from "../domain/chats.ts";
import { UserError } from "../domain/errors.ts";
import { ProjectService } from "../domain/projects.ts";
import { ThreadService } from "../domain/threads.ts";
import type { Store } from "../store/store.ts";
import { escapeHtml, truncate } from "../telegram/format.ts";
import { ChatBudget } from "../telegram/limiter.ts";
import { PermissionBroker } from "../telegram/permissions.ts";
import { sendHtml, TopicGoneError } from "../telegram/send.ts";
import { keyOf, sequenceKey, targetOf } from "../telegram/target.ts";
import { titleFromPrompt, TelegramTopics } from "../telegram/topics.ts";
import { RendererRegistry, type App, type BotInfo } from "./context.ts";
import { registerControl } from "./control.ts";
import { CallbackRouter, CommandRegistry } from "./registry.ts";
import { handleThreadInput, passThrough, registerThread } from "./thread.ts";
import { NO_CHAT_HINT, reply, replyTo, THREADED_MODE_HINT } from "./views.ts";

export interface CreateAppOptions {
  cfg: Config;
  bot: Bot;
  botInfo: BotInfo;
  factory: ProcessFactory;
  store: Store;
  sessions: SessionApi;
  log: Logger;
}

/** Build every service, wire the pool to Telegram and install the update handlers on `bot`. */
export function createApp(opts: CreateAppOptions): App {
  const { cfg, bot, store, log } = opts;
  const api = bot.api;
  const app = {} as App; // hooks below run after construction and read the finished object

  const chats = new ChatService(store, () => ({
    model: cfg.defaultModel,
    permissionMode: cfg.defaultPermissionMode,
    effort: cfg.defaultEffort,
    verbose: false,
  }));
  const projects = new ProjectService(store, chats, { allowedRoots: cfg.allowedRoots });
  projects.bootstrap(cfg.defaultCwd);
  const catalog = new CommandCatalog();

  const pool = new SessionPool(
    opts.factory,
    { maxLive: cfg.maxLiveSessions, idleMs: cfg.sessionIdleMs, backgroundMaxMs: cfg.backgroundMaxMs },
    {
      canUseTool: (key) => app.broker.canUseToolFor(key),
      onMessage: async (key, msg) => {
        if (msg.type === "system" && msg.subtype === "init") {
          app.catalog.update({ version: msg.claude_code_version });
          const record = app.threads.get(key);
          if (record?.permissionMode === "auto" && msg.permissionMode !== "auto") {
            // Auto mode is not available for this account or model: fall back, and say so once.
            await app.threads.setPermissionMode(key, "acceptEdits");
            await app.renderers
              .get(key)
              .notice("⚠️ Auto mode isn't available for this account or model; this tab now uses <b>acceptEdits</b>. Change it with /mode.")
              .catch(() => {});
          }
        }
        app.threads.observe(key, msg);
        if (msg.type === "system" && msg.subtype === "commands_changed") app.catalog.update({ commands: msg.commands });
        try {
          await app.renderers.get(key).handle(msg);
        } catch (err) {
          if (err instanceof TopicGoneError) await app.onTopicGone(key);
          else throw err;
        }
      },
      onExit: (key, reason, error) => {
        app.broker.cancel(key);
        app.renderers.dispose(key);
        log.info(`session ${key} hibernated (${reason})`);
        if (reason === "crash") {
          const why = error instanceof Error ? error.message : String(error ?? "unknown error");
          replyTo(app, targetOfKey(key), `⚠️ Claude Code exited: <code>${escapeHtml(truncate(why, 300))}</code>\nYour next message resumes the session.`).catch(
            (err) => (err instanceof TopicGoneError ? void app.onTopicGone(key) : log.warn("crash notice failed:", err)),
          );
        }
      },
      onWaiting: (key, info) => {
        app.renderers
          .get(key)
          .notice(`⏳ All ${info.busy} Claude slots are busy; this message starts when one frees up. /sessions shows them, /stop cancels.`)
          .catch(() => {});
      },
    },
    log.child("pool"),
  );

  const threads = new ThreadService({
    store,
    chats,
    projects,
    pool,
    topics: new TelegramTopics(api),
    sessions: opts.sessions,
    titleFromPrompt,
    log: log.child("threads"),
  });

  const renderers = new RendererRegistry({
    api,
    stream: { mode: cfg.streamMode },
    budget: new ChatBudget(),
    verbose: (key) => threads.get(key)?.verbose ?? false,
    log,
    onGone: (key) => void app.onTopicGone(key),
  });

  const broker = new PermissionBroker(api, cfg.permissionTimeoutMs, { onBlocked: (key, d) => pool.setBlocked(key, d) }, log.child("prompts"));

  Object.assign(app, {
    cfg,
    log,
    api,
    botInfo: opts.botInfo,
    store,
    access: new AccessControl(cfg.allowedUserIds),
    chats,
    projects,
    threads,
    pool,
    sessions: opts.sessions,
    catalog,
    names: new CommandNameMap(),
    broker,
    renderers,
    commands: new CommandRegistry<App>(),
    callbacks: new CallbackRouter<App>(),
    startedAt: Date.now(),
    topicNames: new Map(),
    announced: new Set(),
    onTopicGone: async (key: ThreadKey) => {
      // The user deleted the chat, so there is nowhere to report this; the session stays resumable.
      app.renderers.dispose(key);
      app.broker.cancel(key);
      app.announced.delete(key);
      const record = await app.threads.topicGone(key);
      if (record) log.info(`chat ${key} was deleted; session ${record.sessionId} hibernated (reopen with /resume)`);
    },
  } satisfies App);

  registerControl(app);
  registerThread(app);
  installHandlers(app, bot);
  return app;
}

function installHandlers(app: App, bot: Bot): void {
  // Updates of one chat are handled in order; different chats run concurrently.
  bot.use(sequentialize(sequenceKey));
  bot.use((ctx, next) => accessGate(app, ctx, next));
  bot.use((ctx, next) => errorBoundary(app, ctx, next));

  // A new chat: remember its name; the session is bound when the chat first needs one.
  bot.on("message:forum_topic_created", (ctx) => {
    const key = keyOf(targetOf(ctx)!);
    const created = ctx.message.forum_topic_created;
    if (key && !app.threads.get(key)) app.topicNames.set(key, { name: created.name, implicit: created.is_name_implicit === true });
  });

  bot.on("message:forum_topic_edited", async (ctx) => {
    const key = keyOf(targetOf(ctx)!);
    const name = ctx.message.forum_topic_edited.name;
    if (!key || !name) return;
    if (app.threads.get(key)) await app.threads.topicRenamed(key, name);
    else app.topicNames.set(key, { name, implicit: false });
  });

  bot.on("message", (ctx) => route(app, ctx));

  bot.on("callback_query:data", async (ctx) => {
    if (await app.broker.handleCallback(ctx)) return;
    if (await app.callbacks.dispatch(app, ctx)) return;
    await ctx.answerCallbackQuery();
  });
}

const USER_CONTENT = ["sticker", "voice", "video", "audio", "animation", "video_note", "location", "contact", "poll"] as const;

async function route(app: App, ctx: Context): Promise<void> {
  const target = targetOf(ctx)!;
  const key = keyOf(target);
  const msg = ctx.message!;

  // Bot commands are mechanical and work in every chat; other /commands belong to Claude Code.
  const cmd = msg.text ? parseCommand(msg.text) : null;
  if (cmd) {
    const def = app.commands.get(cmd.name);
    if (def) return def.run(app, { ctx, target, key, name: cmd.name, args: cmd.args });
    if (key) return passThrough(app, key, cmd.name, cmd.args);
    return void (await reply(app, ctx, app.botInfo.hasTopics ? NO_CHAT_HINT : THREADED_MODE_HINT));
  }

  const hasContent = msg.text !== undefined || msg.photo || msg.document;
  if (!key) {
    // Only possible without Threaded Mode (or in the General thread): no chat to bind a session to.
    if (hasContent) await reply(app, ctx, app.botInfo.hasTopics ? NO_CHAT_HINT : THREADED_MODE_HINT);
    return;
  }
  if (hasContent) return handleThreadInput(app, ctx, key);
  if (USER_CONTENT.some((k) => k in msg)) await reply(app, ctx, "Unsupported message type here. Send text, a photo or a file.");
  // Other service messages (pins, edits…) are ignored.
}

/** Private chats with allowlisted users only; strangers learn their ID (rate-limited). */
async function accessGate(app: App, ctx: Context, next: NextFunction): Promise<void> {
  if (ctx.chat?.type !== "private") return;
  const uid = ctx.from?.id;
  if (!app.access.isAllowed(uid)) {
    if (uid !== undefined && ctx.message && !ctx.from?.is_bot && app.access.shouldReply(uid)) {
      await sendHtml(
        app.api,
        targetOf(ctx)!,
        `🔒 This bot is private.\nYour Telegram user ID: <code>${uid}</code>\nAsk the owner to add it to <code>ALLOWED_USER_IDS</code>.`,
      ).catch(() => {});
      app.log.info(`replied to unknown user ${uid}`);
    }
    return;
  }
  app.chats.ensure(ctx.chat.id);
  await next();
}

/** Expected errors become a short reply; the rest are logged and reported. */
async function errorBoundary(app: App, ctx: Context, next: NextFunction): Promise<void> {
  try {
    await next();
  } catch (err) {
    if (err instanceof TopicGoneError) {
      const key = keyOf(err.target);
      if (key) await app.onTopicGone(key);
      return;
    }
    const isUser = err instanceof UserError;
    if (!isUser) app.log.error(`update ${ctx.update.update_id} failed:`, err);
    const text = isUser ? `⚠️ ${err.message}` : `❌ ${escapeHtml(truncate(err instanceof Error ? err.message : String(err), 400))}`;
    try {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: truncate(text.replace(/<[^>]+>/g, ""), 190), show_alert: isUser });
      else await reply(app, ctx, text);
    } catch {
      // nothing more to do
    }
  }
}

/** Bot commands plus Claude Code's (mapped to Telegram's naming rules) as the chat menu. */
export async function syncMenu(app: App): Promise<void> {
  const own = app.commands.menu();
  const pairs = app.names.rebuild(app.catalog.commandNames, app.commands.names());
  const descriptions = new Map(app.catalog.commands.map((c) => [c.name, c.description]));
  const claude = pairs.map(([command, name]) => ({
    command,
    description: truncate((descriptions.get(name) || name).replace(/\s+/g, " ").trim() || name, 256),
  }));
  await app.api.setMyCommands([...own, ...claude].slice(0, 100));
}
