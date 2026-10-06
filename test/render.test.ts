import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { emptyState } from "../src/core/types.ts";
import { JsonFileStore } from "../src/store/store.ts";
import { elapsed } from "../src/telegram/working.ts";
import { tick, waitFor, type FakeProcess } from "./helpers/fake-process.ts";
import { harness, OWNER } from "./helpers/harness.ts";

type Harness = ReturnType<typeof harness>;

const init = (p: FakeProcess) => ({ type: "system", subtype: "init", session_id: p.sessionId, model: "m", claude_code_version: "9.9.9" });
const block = (b: Record<string, unknown>) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [b] } });
const text = (t: string) => block({ type: "text", text: t });
const tool = (name: string, input: Record<string, unknown>) => block({ type: "tool_use", id: "t", name, input });
const thought = (t: string) => block({ type: "thinking", thinking: t, signature: "s" });
const result = (t: string) => ({ type: "result", subtype: "success", is_error: false, result: t, duration_ms: 1234, num_turns: 3 });

/** Play `steps` for the next message instead of the harness's echo; resolves when they are done. */
function script(h: Harness, steps: (p: FakeProcess) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    h.factory.onSend = (p) => {
      setTimeout(() => steps(p).then(resolve, reject), 1);
    };
  });
}

/** A turn with notes and tool calls between Claude's steps, ending in an answer. */
const busyTurn = async (p: FakeProcess) => {
  await p.emit(init(p));
  await p.emit(thought("The user wants the tests checked."));
  await p.emit(text("I'll check the tests first."));
  await p.emit(tool("Bash", { command: "npm test" }));
  await p.emit(block({ type: "tool_use", id: "s", name: "Read", input: { file_path: "README.md" } }));
  await p.emit({ ...tool("Grep", { pattern: "x" }), parent_tool_use_id: "s" });
  await p.emit(text("Tests pass. Now the docs."));
  await p.emit(tool("Read", { file_path: "README.md" }));
  await p.emit(text("All good: 110 tests pass."));
  await p.emit(result("All good: 110 tests pass."));
};

const workingMessages = (h: Harness) => h.messages.filter((m) => String(m.payload.text).startsWith("⏳ Working"));

test("by default a chat gets Claude's answer only: no notes, thinking or tool calls", async () => {
  const h = harness();
  const turn = script(h, busyTurn);
  await h.send("check it", { thread: 500 });
  await turn;
  const out = h.texts(h.inThread(500));
  assert.equal(out.filter((t) => t.includes("All good: 110 tests pass.")).length, 1);
  for (const hidden of ["check the tests", "Now the docs", "wants the tests", "Bash", "npm test", "README", "Grep", "⏱"]) {
    assert.ok(!out.some((t) => t.includes(hidden)), `"${hidden}" was shown:\n${out.join("\n")}`);
  }
});

test("/thinking shows Claude's notes, thinking and timings, still no tool calls; it reaches the process", async () => {
  const h = harness();
  await h.send("/thinking", { thread: 500 });
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.thinking, true);
  assert.match(h.texts(h.inThread(500)).at(-1)!, /Thinking on/);
  const turn = script(h, busyTurn);
  await h.send("check it", { thread: 500 });
  await turn;
  const p = h.factory.last();
  assert.equal(p.spec.showThinking, true, "a new process asks for thinking summaries");
  const out = h.texts(h.inThread(500));
  assert.ok(out.some((t) => t === "💭 <blockquote expandable>The user wants the tests checked.</blockquote>"), out.join("\n"));
  assert.ok(out.some((t) => t.includes("check the tests first")));
  assert.ok(out.some((t) => t.includes("Now the docs")));
  assert.ok(out.some((t) => t.includes("All good")));
  assert.match(out.at(-1)!, /⏱ 1\.2s · 3 turns/);
  for (const hidden of ["Bash", "npm test", "Grep"]) assert.ok(!out.some((t) => t.includes(hidden)), hidden);

  await h.send("/thinking", { thread: 500 });
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.thinking, false);
  assert.deepEqual(p.controls, ["thinking:off"], "a live process follows the switch");
});

test("a working message shows while Claude works, silently, with Stop; it goes before the answer", async () => {
  const h = harness({ working: { delayMs: 5 } });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const turn = script(h, async (p) => {
    await p.emit(init(p));
    await p.emit(tool("Bash", { command: "sleep 5" }));
    await gate;
    await p.emit(text("Done."));
    await p.emit(result("Done."));
  });
  await h.send("go", { thread: 500 });
  await waitFor(() => workingMessages(h).length === 1, 1000, "working message");
  const w = workingMessages(h)[0];
  assert.equal(w.payload.message_thread_id, 500);
  assert.equal(w.payload.disable_notification, true);
  assert.match(JSON.stringify(w.payload.reply_markup), /"callback_data":"stop:"/);
  release();
  await turn;
  const deleted = h.calls.findIndex((c) => c.method === "deleteMessage" && c.payload.message_id === w.id);
  const answer = h.calls.findIndex((c) => c.method === "sendMessage" && c.payload.text === "Done.");
  assert.ok(deleted >= 0 && deleted < answer, "deleted before the answer");
  assert.equal(h.texts(h.inThread(500)).at(-1), "Done.");
  assert.equal(workingMessages(h).length, 1);
});

test("a quick reply never shows the working message", async () => {
  const h = harness({ working: { delayMs: 60 } });
  await h.send("hi", { thread: 500 });
  await waitFor(() => h.texts(h.inThread(500)).some((t) => t.includes("reply: hi")), 1000, "reply");
  await tick(100);
  assert.equal(workingMessages(h).length, 0);
});

test("Stop on the working message interrupts the turn and removes it", async () => {
  const h = harness({ working: { delayMs: 5 } });
  h.factory.onSend = (p) => void setTimeout(() => p.emit(init(p)), 1);
  await h.send("go", { thread: 500 });
  await waitFor(() => workingMessages(h).length === 1, 1000, "working message");
  const w = workingMessages(h)[0];
  await h.press("stop:", 500, w.id);
  assert.equal(h.factory.last().interrupts, 1);
  await waitFor(() => h.calls.some((c) => c.method === "deleteMessage" && c.payload.message_id === w.id), 1000, "deleted");
  const answered = h.calls.find((c) => c.method === "answerCallbackQuery");
  assert.equal(answered?.payload.text, "⏹ Interrupted");
});

test("while a prompt waits for the user the working message steps aside, then returns below it", async () => {
  const h = harness({ working: { delayMs: 5 } });
  let decision: unknown;
  h.factory.onSend = (p) => {
    setTimeout(async () => {
      await p.emit(init(p));
      await waitFor(() => workingMessages(h).length === 1, 1000, "working message");
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
  const first = workingMessages(h)[0];
  await waitFor(() => h.calls.some((c) => c.method === "deleteMessage" && c.payload.message_id === first.id), 1000, "stepped aside");
  await h.press("p:1:a", 500);
  await waitFor(() => decision !== undefined, 1000, "decision");
  await waitFor(() => workingMessages(h).length === 2, 1000, "back");
  const prompt = h.messages.find((m) => String(m.payload.text).includes("rm -rf build"))!;
  assert.ok(workingMessages(h)[1].id > prompt.id, "below the prompt");
});

test("/verbose still works, as /thinking; so does an old Verbose button in /settings", async () => {
  const h = harness();
  await h.send("/verbose", { thread: 500 });
  assert.equal(h.app.threads.get(`${OWNER}:500`)!.thinking, true);
  await h.press("set:verbose", 500);
  assert.equal(h.app.chats.get(OWNER)!.defaults.thinking, true);
});

test("states written with verbose load with thinking", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgcc-store-"));
  const file = path.join(dir, "state.json");
  const record = { threadId: 500, sessionId: "s", started: true, project: "p", cwd: dir, title: "t", titleSource: "auto",
    permissionMode: "auto", createdAt: 0, lastActiveAt: 0 };
  const state = {
    ...emptyState(),
    botId: 1,
    chats: { [OWNER]: { activeProject: "p", defaults: { permissionMode: "auto", verbose: true },
      threads: { 500: { ...record, verbose: true }, 501: { ...record, threadId: 501, verbose: false } } } },
    botArchive: { 2: { [OWNER]: { 9: { ...record, threadId: 9, verbose: true } } } },
  };
  fs.writeFileSync(file, JSON.stringify(state));
  const data = new JsonFileStore(file).data;
  const chat = data.chats[OWNER];
  assert.deepEqual(chat.defaults, { permissionMode: "auto", thinking: true });
  assert.equal(chat.threads[500].thinking, true);
  assert.equal(chat.threads[501].thinking, false);
  assert.equal(data.botArchive![2][OWNER][9].thinking, true);
  assert.ok(!JSON.stringify(data).includes("verbose"));
});

test("elapsed time reads naturally", () => {
  assert.equal(elapsed(4_200), "4s");
  assert.equal(elapsed(80_000), "1m 20s");
  assert.equal(elapsed(3_900_000), "1h 5m");
});
