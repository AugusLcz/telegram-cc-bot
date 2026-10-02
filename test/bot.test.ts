import assert from "node:assert/strict";
import { test } from "node:test";
import type { Update } from "grammy/types";
import { syncMenu } from "../src/app/bot.ts";
import { Poller } from "../src/telegram/polling.ts";
import { type FakeProcess, waitFor } from "./helpers/fake-process.ts";
import { harness, OWNER, STRANGER } from "./helpers/harness.ts";

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

test("the / menu lists commands only, in every scope a private chat sees", async () => {
  const h = harness();
  h.app.catalog.update({
    commands: [
      { name: "compact", description: "Free up context", argumentHint: "", builtin: true },
      { name: "code-review", description: "Review", argumentHint: "", builtin: true },
      { name: "theme", description: "Change the theme", argumentHint: "", builtin: true },
      { name: "status", description: "Claude Code's own status", argumentHint: "", builtin: true },
      { name: "my-skill", description: "Mine", argumentHint: "" },
    ],
  });
  await syncMenu(h.app);
  const sets = h.calls.filter((c) => c.method === "setMyCommands");
  assert.deepEqual(
    sets.map((c) => c.payload.scope),
    [{ type: "default" }, { type: "all_private_chats" }, { type: "chat", chat_id: OWNER }],
  );
  const commands = sets[0].payload.commands as { command: string; description: string }[];
  const names = commands.map((c) => c.command);
  assert.ok(names.includes("help") && names.includes("skills"), "bot commands");
  assert.deepEqual(commands.find((c) => c.command === "compact"), { command: "compact", description: "Free up context" });
  assert.ok(names.indexOf("help") < names.indexOf("compact"), "the bot's commands first");
  for (const hidden of ["code_review", "my_skill", "theme"]) assert.ok(!names.includes(hidden), `${hidden} is not in the menu`);
  assert.equal(names.filter((n) => n === "status").length, 1, "the bot's /status, once");
  assert.ok(!names.includes("branch") && !names.includes("bashes"), "aliases stay out");
  assert.ok(commands.length <= 100);
  assert.ok(sets.every((c) => JSON.stringify(c.payload.commands) === JSON.stringify(commands)));

  await h.send("/code_review the auth module", { thread: 500 });
  await waitFor(() => h.factory.created.length === 1, 1000, "skill sent to Claude");
  assert.equal(h.factory.created[0].sent[0], "/code-review the auth module", "hidden skills still run by name");
});

test("if Telegram rejects Claude Code's commands, the bot's own menu still goes in", async () => {
  const h = harness({
    reject: (method, p) =>
      method === "setMyCommands" && (p.commands as { command: string }[]).some((c) => c.command === "compact")
        ? "Bad Request: BOT_COMMAND_INVALID"
        : undefined,
  });
  await syncMenu(h.app);
  const last = h.calls.filter((c) => c.method === "setMyCommands").at(-1)!;
  const commands = last.payload.commands as { command: string }[];
  assert.ok(commands.some((c) => c.command === "help"));
  assert.ok(!commands.some((c) => c.command === "compact"));
});

test("/resume in a chat continues the chosen session in that same chat", async () => {
  const h = harness();
  await h.send("first question", { thread: 500 });
  await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("reply: first question")), 1000, "first reply");
  const id = "12345678-aaaa-bbbb-cccc-1234567890ab";
  h.app.sessions.info = async () => ({ sessionId: id, summary: "Earlier work", lastModified: 1, cwd: h.home });

  await h.send(`/resume ${id}`, { thread: 500 });
  assert.equal(h.calls.some((c) => c.method === "createForumTopic"), false, "no new chat");
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.sessionId, id);
  const here = h.texts(h.inThread(500));
  assert.ok(here.some((t) => t.includes("Resumed: <b>Earlier work</b>")));
  assert.ok(here.some((t) => t.includes("Continuing")));

  await h.send("and now?", { thread: 500 });
  await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("reply: and now?")), 1000, "reply in the resumed session");
  const spec = h.factory.created.at(-1)!.spec;
  assert.equal(spec.sessionId, id);
  assert.equal(spec.resume, true);
});
