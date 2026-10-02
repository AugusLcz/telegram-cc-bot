import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { createApp } from "../../src/app/bot.ts";
import type { App } from "../../src/app/context.ts";
import type { SessionApi } from "../../src/claude/sessions.ts";
import { loadConfig } from "../../src/core/config.ts";
import type { Exec } from "../../src/core/exec.ts";
import { silentLogger } from "../../src/core/logger.ts";
import { MemoryStore } from "../../src/store/store.ts";
import { FakeFactory } from "./fake-process.ts";

export const OWNER = 42;
export const STRANGER = 7;

export interface Call {
  method: string;
  payload: Record<string, unknown>;
}

export interface HarnessOptions {
  hasTopics?: boolean;
  /** Make a Bot API call fail with this description. */
  reject?: (method: string, payload: Record<string, unknown>) => string | undefined;
  getUpdates?: (signal?: { addEventListener(type: "abort", fn: () => void): void }) => Promise<Update[]>;
  exec?: Exec;
}

/** A bot wired to fake Telegram, fake Claude Code processes and an in-memory store. */
export function harness(opts: HarnessOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tgcc-bot-"));
  const home = path.join(root, "home");
  const other = path.join(root, "other");
  fs.mkdirSync(home);
  fs.mkdirSync(other);
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "123456:TEST",
    ALLOWED_USER_IDS: String(OWNER),
    DEFAULT_CWD: home,
    ALLOWED_ROOTS: root,
    STREAM_MODE: "off",
  });
  const botInfo = { id: 999, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;
  const bot = new Bot(cfg.botToken, { botInfo });

  const calls: Call[] = [];
  /** Messages the bot sent, with the IDs the fake API gave them. */
  const messages: { id: number; payload: Record<string, unknown> }[] = [];
  const goneThreads = new Set<number>();
  let messageId = 1000;
  let threadId = 900; // topics the bot creates itself (/resume, /fork)
  bot.api.config.use(async (_prev, method, payload, signal) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    const rejected = opts.reject?.(method, p);
    if (rejected) return { ok: false, error_code: 400, description: rejected } as never;
    if (method === "getUpdates" && opts.getUpdates) return { ok: true, result: await opts.getUpdates(signal) } as never;
    if (typeof p.message_thread_id === "number" && goneThreads.has(p.message_thread_id)) {
      return { ok: false, error_code: 400, description: "Bad Request: message thread not found" } as never;
    }
    let result: unknown = true;
    if (method === "sendMessage" || method === "sendDocument") {
      const id = messageId++;
      if (method === "sendMessage") messages.push({ id, payload: p });
      result = { message_id: id, date: 0, chat: { id: p.chat_id, type: "private" }, text: p.text };
    } else if (method === "createForumTopic") {
      result = { message_thread_id: threadId++, name: p.name, icon_color: 0 };
    }
    return { ok: true, result } as never;
  });

  // Fake Claude: answers every message with "reply: <text>".
  const factory = new FakeFactory();
  factory.onSend = (p, content) => {
    setTimeout(async () => {
      await p.emit({ type: "system", subtype: "init", session_id: p.sessionId, model: "m", claude_code_version: "9.9.9" });
      await p.finishTurn(`reply: ${typeof content === "string" ? content : "[blocks]"}`);
    }, 1);
  };
  const sessions: SessionApi = {
    list: async () => [],
    info: async () => undefined,
    fork: async (id) => `${id}-fork`,
    rename: async () => {},
    recap: async () => ({}),
    transcript: async () => [],
  };
  const store = new MemoryStore();
  const app = createApp({
    cfg,
    bot,
    botInfo: { username: "test_bot", hasTopics: opts.hasTopics ?? true, usersCreateTopics: true },
    factory,
    store,
    sessions,
    log: silentLogger,
    exec: opts.exec,
  });
  app.catalog.update({
    commands: [
      { name: "compact", description: "Free up context", argumentHint: "", builtin: true },
      { name: "code-review", description: "Review", argumentHint: "", builtin: true },
    ],
  });

  let updateId = 1;
  type SendOpts = { thread?: number; from?: number; extra?: Record<string, unknown> };
  const message = (text: string, opts: SendOpts = {}): Update => {
    const from = opts.from ?? OWNER;
    const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : undefined;
    return {
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: from, type: "private", first_name: "U" },
        from: { id: from, is_bot: false, first_name: "U" },
        text,
        entities,
        ...(opts.thread ? { message_thread_id: opts.thread, is_topic_message: true } : {}),
        ...opts.extra,
      },
    } as unknown as Update;
  };
  const send = (text: string, opts: SendOpts = {}) => bot.handleUpdate(message(text, opts));
  const press = (data: string, thread?: number, messageId = 1) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        from: { id: OWNER, is_bot: false, first_name: "U" },
        chat_instance: "c",
        data,
        message: {
          message_id: messageId,
          date: 0,
          chat: { id: OWNER, type: "private", first_name: "U" },
          ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}),
        },
      },
    } as unknown as Update);

  const texts = (filter: (c: Call) => boolean = () => true) =>
    calls.filter((c) => c.method === "sendMessage" && filter(c)).map((c) => String(c.payload.text));
  const inThread = (t?: number) => (c: Call) => c.payload.message_thread_id === t;

  return { app: app as App, bot, calls, messages, goneThreads, factory, store, message, send, press, texts, inThread, home, other };
}
