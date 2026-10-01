import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { createApp } from "../src/app/bot.ts";
import type { App } from "../src/app/context.ts";
import type { SessionApi } from "../src/claude/sessions.ts";
import { loadConfig } from "../src/core/config.ts";
import { silentLogger } from "../src/core/logger.ts";
import { MemoryStore } from "../src/store/store.ts";
import { FakeFactory, type FakeProcess, waitFor } from "./helpers/fake-process.ts";

const OWNER = 42;
const STRANGER = 7;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function harness(opts: { hasTopics?: boolean } = {}) {
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
  const goneThreads = new Set<number>();
  let messageId = 1000;
  let threadId = 500;
  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    if (typeof p.message_thread_id === "number" && goneThreads.has(p.message_thread_id)) {
      return { ok: false, error_code: 400, description: "Bad Request: message thread not found" } as never;
    }
    let result: unknown = true;
    if (method === "sendMessage" || method === "sendDocument") {
      result = { message_id: messageId++, date: 0, chat: { id: p.chat_id, type: "private" }, text: p.text };
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
  });
  app.catalog.update({ commands: [{ name: "code-review", description: "Review", argumentHint: "" }] });

  let updateId = 1;
  const send = (text: string, opts: { thread?: number; from?: number; extra?: Record<string, unknown> } = {}) => {
    const from = opts.from ?? OWNER;
    const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : undefined;
    const update = {
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
    };
    return bot.handleUpdate(update as unknown as Update);
  };
  const press = (data: string, thread?: number) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        from: { id: OWNER, is_bot: false, first_name: "U" },
        chat_instance: "c",
        data,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: OWNER, type: "private", first_name: "U" },
          ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}),
        },
      },
    } as unknown as Update);

  const texts = (filter: (c: Call) => boolean = () => true) =>
    calls.filter((c) => c.method === "sendMessage" && filter(c)).map((c) => String(c.payload.text));
  const inThread = (t?: number) => (c: Call) => c.payload.message_thread_id === t;

  return { app: app as App, bot, calls, goneThreads, factory, store, send, press, texts, inThread, home, other };
}

test("strangers only learn their user ID, once per cooldown", async () => {
  const h = harness();
  await h.send("hello", { from: STRANGER });
  await h.send("hello again", { from: STRANGER });
  const replies = h.texts();
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Your Telegram user ID: <code>7<\/code>/);
  assert.equal(h.factory.created.length, 0);
});

test("the main view is a control panel: text gets a hint, Claude commands are redirected", async () => {
  const h = harness();
  await h.send("hi there");
  await h.send("/compact");
  await h.send("/stop");
  const [hint, claudeCmd, threadOnly] = h.texts(h.inThread(undefined));
  assert.match(hint, /control panel/);
  assert.match(claudeCmd, /work inside a session tab/);
  assert.match(threadOnly, /\/stop works inside a session tab/);
  assert.equal(h.factory.created.length, 0);
});

test("/new opens a tab in the active project and the tab talks to Claude", async () => {
  const h = harness();
  await h.send("/new");
  const create = h.calls.find((c) => c.method === "createForumTopic")!;
  assert.equal(create.payload.name, "New session");
  const tab = 500;
  assert.match(h.texts(h.inThread(tab))[0], /New session\. Send a message to start/);
  assert.match(h.texts(h.inThread(undefined))[0], /Opened <b>New session<\/b> in <b>home<\/b>/);

  await h.send("Fix the build", { thread: tab });
  await waitFor(() => h.texts(h.inThread(tab)).some((t) => t.includes("reply: Fix the build")), 1000, "Claude reply in tab");
  const proc = h.factory.last() as FakeProcess;
  assert.equal(proc.spec.cwd, h.home);
  assert.equal(proc.spec.resume, false);
  const rename = h.calls.find((c) => c.method === "editForumTopic")!;
  assert.equal(rename.payload.name, "Fix the build", "tab auto-titled from the first prompt");
  assert.equal(h.app.threads.get(`${OWNER}:${tab}`)!.started, true);
});

test('a "+" tab binds to the active project at creation', async () => {
  const h = harness();
  await h.send("/project add other " + h.other);
  await h.send("", { thread: 777, extra: { text: undefined, forum_topic_created: { name: "Topic", icon_color: 0, is_name_implicit: true } } });
  const record = h.app.threads.get(`${OWNER}:777`)!;
  assert.equal(record.project, "other");
  assert.equal(record.cwd, h.other);
  assert.equal(record.titleSource, "placeholder");
  assert.match(h.texts(h.inThread(777))[0], /other/);
});

test("messages in an unknown tab bind it lazily", async () => {
  const h = harness();
  await h.send("hello", { thread: 888 });
  assert.ok(h.app.threads.get(`${OWNER}:888`));
  await waitFor(() => h.texts(h.inThread(888)).some((t) => t.includes("reply: hello")), 1000, "reply");
});

test("tab commands: wrong-scope redirect, passthrough with menu-name mapping, settings per tab", async () => {
  const h = harness();
  await h.send("/new");
  const tab = 500;
  await h.send("/projects", { thread: tab });
  assert.match(h.texts(h.inThread(tab)).at(-1)!, /works in the main view/);

  await h.send("/code_review src/", { thread: tab });
  await waitFor(() => h.factory.created.length === 1 && h.factory.last().sent.length === 1, 1000, "passthrough");
  assert.equal(h.factory.last().sent[0], "/code-review src/");

  await h.send("/model opus", { thread: tab });
  assert.equal(h.app.threads.get(`${OWNER}:${tab}`)!.model, "opus");
  await waitFor(() => h.factory.last().model === "opus", 500, "model applied live");
});

test("a deleted tab is detected on send and reported in the main view", async () => {
  const h = harness();
  await h.send("/new");
  const tab = 500;
  h.goneThreads.add(tab);
  await h.send("anyone there?", { thread: tab });
  await waitFor(() => h.texts(h.inThread(undefined)).some((t) => t.includes("no longer exists")), 1000, "gone notice");
  assert.equal(h.app.threads.get(`${OWNER}:${tab}`), undefined);
});

test("permission prompts become buttons in the tab and keep the session busy", async () => {
  const h = harness();
  let decision: unknown;
  h.factory.onSend = (p) => {
    setTimeout(async () => {
      decision = await p.hooks.canUseTool("Bash", { command: "rm -rf build" }, {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "t1",
        requestId: "r1",
      });
    }, 1);
  };
  await h.send("/new");
  const tab = 500;
  await h.send("clean up", { thread: tab });
  await waitFor(() => h.texts(h.inThread(tab)).some((t) => t.includes("rm -rf build")), 1000, "prompt");
  assert.equal(h.app.pool.state(`${OWNER}:${tab}`), "busy");
  await h.press("p:1:a", tab);
  await waitFor(() => decision !== undefined, 1000, "decision");
  assert.deepEqual(decision, { behavior: "allow" });
});

test("/settings changes defaults for new tabs only", async () => {
  const h = harness();
  await h.send("/new");
  await h.send("/settings");
  await h.press("set:verbose");
  await h.press("sdp:plan");
  assert.equal(h.app.chats.get(OWNER)!.defaults.verbose, true);
  assert.equal(h.app.chats.get(OWNER)!.defaults.permissionMode, "plan");
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.permissionMode, "auto", "existing tab unchanged");
  await h.send("/new");
  assert.equal(h.app.threads.get(`${OWNER}:501`)!.permissionMode, "plan");
});

test("without Threaded Mode, /new explains how to enable it", async () => {
  const h = harness({ hasTopics: false });
  await h.send("/new");
  assert.match(h.texts().at(-1)!, /Threaded Mode/);
  assert.equal(h.calls.some((c) => c.method === "createForumTopic"), false);
});

test("auto mode unavailable: the tab falls back to acceptEdits and says so", async () => {
  const h = harness();
  h.factory.onSend = (p) => {
    setTimeout(async () => {
      await p.emit({ type: "system", subtype: "init", session_id: p.sessionId, permissionMode: "default" });
      await p.finishTurn("ok");
    }, 1);
  };
  await h.send("/new");
  await h.send("hi", { thread: 500 });
  await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("Auto mode isn't available")), 1000, "fallback notice");
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.permissionMode, "acceptEdits");
  assert.equal(h.factory.last().permissionMode, "acceptEdits");
});
