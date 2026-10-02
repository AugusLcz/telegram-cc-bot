import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { createApp, syncMenu } from "../src/app/bot.ts";
import type { App } from "../src/app/context.ts";
import type { SessionApi } from "../src/claude/sessions.ts";
import { loadConfig } from "../src/core/config.ts";
import { silentLogger } from "../src/core/logger.ts";
import { MemoryStore } from "../src/store/store.ts";
import { Poller } from "../src/telegram/polling.ts";
import { FakeFactory, type FakeProcess, waitFor } from "./helpers/fake-process.ts";

const OWNER = 42;
const STRANGER = 7;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function harness(opts: { hasTopics?: boolean; reject?: (method: string, payload: Record<string, unknown>) => string | undefined; getUpdates?: (signal?: { addEventListener(type: "abort", fn: () => void): void }) => Promise<Update[]> } = {}) {
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

  return { app: app as App, bot, calls, goneThreads, factory, store, message, send, press, texts, inThread, home, other };
}

test("messages left in two chats while the bot was down: one poll loop serves both sessions", async () => {
  // Telegram queues both messages; on start, the first getUpdates returns them together, and
  // every later one is a long poll that waits until polling stops.
  let backlog: Update[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let polls = 0;
  const h = harness({
    getUpdates: async (signal) => {
      polls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (polls === 1) return backlog;
        return await new Promise<Update[]>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      } finally {
        inFlight--;
      }
    },
  });
  backlog = [h.message("first task", { thread: 500 }), h.message("second task", { thread: 501 })];
  const poller = new Poller(h.bot, { onFatal: () => assert.fail("fatal") });
  poller.start();
  try {
    await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("reply: first task")), 2000, "reply in chat 500");
    await waitFor(() => h.texts(h.inThread(501)).some((t) => t.includes("reply: second task")), 2000, "reply in chat 501");
    assert.equal(h.factory.created.length, 2, "one Claude Code process per chat");
    assert.ok(polls >= 2, "kept long-polling while both sessions ran");
    assert.equal(maxInFlight, 1, "never two getUpdates at once, however many sessions run");
    assert.equal(h.calls.filter((c) => c.method === "getUpdates").length, polls, "only the poller asks for updates");
  } finally {
    await poller.stop();
  }
});

test("strangers only learn their user ID, once per cooldown", async () => {
  const h = harness();
  await h.send("hello", { from: STRANGER, thread: 500 });
  await h.send("hello again", { from: STRANGER, thread: 501 });
  const replies = h.texts();
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Your Telegram user ID: <code>7<\/code>/);
  assert.equal(h.factory.created.length, 0);
  assert.equal(h.app.threads.list(STRANGER).length, 0);
});

test("each new chat is its own session in the active project", async () => {
  const h = harness();
  await h.send("Fix the build", { thread: 500 });
  await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("reply: Fix the build")), 1000, "reply in chat 500");
  const first = h.texts(h.inThread(500));
  assert.match(first[0], /<b>home<\/b>.* · new session/, "session start line comes before the reply");
  const rename = h.calls.find((c) => c.method === "editForumTopic")!;
  assert.equal(rename.payload.name, "Fix the build", "chat titled from its first prompt");

  await h.send("Another task", { thread: 501 });
  await waitFor(() => h.texts(h.inThread(501)).some((t) => t.includes("reply: Another task")), 1000, "reply in chat 501");
  assert.equal(h.factory.created.length, 2);
  const [a, b] = [h.app.threads.get(`${OWNER}:500`)!, h.app.threads.get(`${OWNER}:501`)!];
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(h.factory.created[0].spec.cwd, h.home);

  await h.send("follow-up", { thread: 500 });
  await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("reply: follow-up")), 1000, "follow-up");
  assert.equal(h.texts(h.inThread(500)).filter((t) => t.includes("new session")).length, 1, "start line only once");
  assert.equal(h.calls.some((c) => c.method === "createForumTopic"), false, "the bot never needs to create chats for this");
});

test("bot commands work in any chat and leave no session behind", async () => {
  const h = harness();
  await h.send("/projects", { thread: 600 });
  await h.send("/status", { thread: 601 });
  await h.send("/settings", { thread: 602 });
  await h.send("/sessions", { thread: 603 });
  await h.send("/help", { thread: 604 });
  assert.match(h.texts(h.inThread(600))[0], /Projects/);
  assert.match(h.texts(h.inThread(601))[0], /No session in this chat yet/);
  assert.match(h.texts(h.inThread(602))[0], /Defaults for new chats/);
  assert.match(h.texts(h.inThread(603))[0], /No sessions yet/);
  assert.match(h.texts(h.inThread(604))[0], /<b>This chat<\/b>[\s\S]*\/stop[\s\S]*<b>Bot<\/b>[\s\S]*\/projects/);
  assert.doesNotMatch(h.texts(h.inThread(604))[0], /\/new\b/);
  assert.equal(h.factory.created.length, 0);
  assert.equal(h.app.threads.list(OWNER).length, 0, "no records for command-only chats");
});

test("/project use moves a chat that has not started; a started chat keeps its directory", async () => {
  const h = harness();
  await h.send(`/project add other ${h.other}`, { thread: 700 });
  assert.match(h.texts(h.inThread(700)).at(-1)!, /This chat and new chats use <b>other<\/b>/);
  await h.send("hi", { thread: 700 });
  await waitFor(() => h.factory.created.length === 1, 1000, "process");
  assert.equal(h.factory.last().spec.cwd, h.other);
  await waitFor(() => h.app.threads.get(`${OWNER}:700`)!.started, 1000, "started");

  await h.send("/project use home", { thread: 700 });
  assert.match(h.texts(h.inThread(700)).at(-1)!, /New chats will use <b>home<\/b>[\s\S]*stays in <b>other<\/b>/);
  assert.equal(h.app.threads.get(`${OWNER}:700`)!.cwd, h.other);
  await h.send("next", { thread: 701 });
  await waitFor(() => h.factory.created.length === 2, 1000, "second process");
  assert.equal(h.factory.last().spec.cwd, h.home);
});

test("a chat the user named keeps its name; an unnamed one is titled from the first prompt", async () => {
  const h = harness();
  const created = (thread: number, name: string, implicit: boolean) =>
    h.send("", { thread, extra: { text: undefined, forum_topic_created: { name, icon_color: 0, is_name_implicit: implicit } } });
  await created(800, "Release prep", false);
  assert.equal(h.app.threads.get(`${OWNER}:800`), undefined, "nothing recorded until the chat is used");
  await h.send("check the changelog", { thread: 800 });
  assert.equal(h.app.threads.get(`${OWNER}:800`)!.title, "Release prep");
  await created(801, "New chat", true);
  await h.send("write tests", { thread: 801 });
  await waitFor(() => h.calls.some((c) => c.method === "editForumTopic" && c.payload.name === "write tests"), 1000, "auto title");
  assert.equal(h.calls.some((c) => c.method === "editForumTopic" && c.payload.message_thread_id === 800), false);
});

test("Claude commands pass through with menu-name mapping; per-chat settings apply live", async () => {
  const h = harness();
  await h.send("/code_review src/", { thread: 500 });
  await waitFor(() => h.factory.created.length === 1 && h.factory.last().sent.length === 1, 1000, "passthrough");
  assert.equal(h.factory.last().sent[0], "/code-review src/");
  await h.send("/model opus", { thread: 500 });
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.model, "opus");
  await waitFor(() => h.factory.last().model === "opus", 500, "model applied live");
});

test("settings set before the first message shape the session", async () => {
  const h = harness();
  await h.send("/mode plan", { thread: 510 });
  await h.send("/effort high", { thread: 510 });
  assert.equal(h.factory.created.length, 0, "no process for settings alone");
  await h.send("go", { thread: 510 });
  await waitFor(() => h.factory.created.length === 1, 1000, "process");
  assert.equal(h.factory.last().spec.permissionMode, "plan");
  assert.equal(h.factory.last().spec.effort, "high");
});

test("a deleted chat is detected on send and forgotten without notices elsewhere", async () => {
  const h = harness();
  await h.send("first", { thread: 500 });
  await waitFor(() => h.app.threads.get(`${OWNER}:500`)?.started === true, 1000, "started");
  h.goneThreads.add(500);
  await h.send("anyone there?", { thread: 500 });
  await waitFor(() => h.app.threads.get(`${OWNER}:500`) === undefined, 1000, "forgotten");
  assert.equal(h.texts(h.inThread(undefined)).length, 0, "nothing is sent outside chats");
});

test("permission prompts become buttons in the chat and keep the session busy", async () => {
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
  await h.send("clean up", { thread: 500 });
  await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("rm -rf build")), 1000, "prompt");
  assert.equal(h.app.pool.state(`${OWNER}:500`), "busy");
  await h.press("p:1:a", 500);
  await waitFor(() => decision !== undefined, 1000, "decision");
  assert.deepEqual(decision, { behavior: "allow" });
});

test("/settings changes defaults for new chats only", async () => {
  const h = harness();
  await h.send("hi", { thread: 500 });
  await waitFor(() => h.app.threads.get(`${OWNER}:500`) !== undefined, 1000, "bound");
  await h.send("/settings", { thread: 500 });
  await h.press("set:verbose", 500);
  await h.press("sdp:plan", 500);
  assert.equal(h.app.chats.get(OWNER)!.defaults.verbose, true);
  assert.equal(h.app.chats.get(OWNER)!.defaults.permissionMode, "plan");
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.permissionMode, "auto", "existing chat unchanged");
  await h.send("x", { thread: 501 });
  assert.equal(h.app.threads.get(`${OWNER}:501`)!.permissionMode, "plan");
});

test("without Threaded Mode, messages explain how to enable it", async () => {
  const h = harness({ hasTopics: false });
  await h.send("hello");
  await h.send("/compact");
  for (const t of h.texts()) assert.match(t, /Threaded Mode/);
  await h.send("/status");
  assert.match(h.texts().at(-1)!, /Threaded Mode OFF/);
  assert.equal(h.factory.created.length, 0);
});

test("auto mode unavailable: the chat falls back to acceptEdits and says so", async () => {
  const h = harness();
  h.factory.onSend = (p) => {
    setTimeout(async () => {
      await p.emit({ type: "system", subtype: "init", session_id: p.sessionId, permissionMode: "default" });
      await p.finishTurn("ok");
    }, 1);
  };
  await h.send("hi", { thread: 500 });
  await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("Auto mode isn't available")), 1000, "fallback notice");
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.permissionMode, "acceptEdits");
  assert.equal(h.factory.last().permissionMode, "acceptEdits");
});

test("the / menu lists bot and Claude Code commands in every scope a private chat sees", async () => {
  const h = harness();
  await syncMenu(h.app);
  const sets = h.calls.filter((c) => c.method === "setMyCommands");
  assert.deepEqual(
    sets.map((c) => c.payload.scope),
    [{ type: "default" }, { type: "all_private_chats" }, { type: "chat", chat_id: OWNER }],
  );
  const commands = sets[0].payload.commands as { command: string; description: string }[];
  assert.ok(commands.some((c) => c.command === "help"), "bot command");
  assert.deepEqual(commands.find((c) => c.command === "code_review"), { command: "code_review", description: "Review" });
  assert.ok(sets.every((c) => JSON.stringify(c.payload.commands) === JSON.stringify(commands)));
});

test("if Telegram rejects Claude Code's commands, the bot's own menu still goes in", async () => {
  const h = harness({
    reject: (method, p) =>
      method === "setMyCommands" && (p.commands as { command: string }[]).some((c) => c.command === "code_review")
        ? "Bad Request: BOT_COMMAND_INVALID"
        : undefined,
  });
  await syncMenu(h.app);
  const last = h.calls.filter((c) => c.method === "setMyCommands").at(-1)!;
  const commands = last.payload.commands as { command: string }[];
  assert.ok(commands.some((c) => c.command === "help"));
  assert.ok(!commands.some((c) => c.command === "code_review"));
});
