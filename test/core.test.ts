import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CallbackRouter, CommandRegistry, callbackData } from "../src/app/registry.ts";
import { KeyedMutex } from "../src/core/mutex.ts";
import { AccessControl } from "../src/domain/access.ts";
import { JsonFileStore } from "../src/store/store.ts";
import { ChatBudget } from "../src/telegram/limiter.ts";
import { keyOf, targetFromMessage, threadParams } from "../src/telegram/target.ts";
import { titleFromPrompt, topicName } from "../src/telegram/topics.ts";
import { tick } from "./helpers/fake-process.ts";

test("KeyedMutex serialises per key and runs keys concurrently", async () => {
  const m = new KeyedMutex();
  const log: string[] = [];
  const job = (key: string, id: string, ms: number) =>
    m.run(key, async () => {
      log.push(`${id}+`);
      await tick(ms);
      log.push(`${id}-`);
    });
  await Promise.all([job("a", "a1", 20), job("a", "a2", 1), job("b", "b1", 5)]);
  assert.ok(log.indexOf("a1-") < log.indexOf("a2+"), "same key must not overlap");
  assert.ok(log.indexOf("b1+") < log.indexOf("a1-"), "other keys run concurrently");
  assert.equal(m.isLocked("a"), false);
});

test("KeyedMutex releases after a failure", async () => {
  const m = new KeyedMutex();
  await assert.rejects(m.run("k", async () => Promise.reject(new Error("x"))));
  assert.equal(await m.run("k", async () => 1), 1);
});

test("JsonFileStore writes atomically and reloads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgcc-store-"));
  const file = path.join(dir, "state.json");
  const store = new JsonFileStore(file, { debounceMs: 5 });
  store.update((d) => {
    d.projects.p = { name: "p", path: "/x", addedAt: 1 };
  });
  await store.flush();
  assert.deepEqual(new JsonFileStore(file).data.projects.p, { name: "p", path: "/x", addedAt: 1 });
  assert.deepEqual(fs.readdirSync(dir), ["state.json"], "no temp files left behind");
});

test("JsonFileStore moves a corrupt file aside and starts empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgcc-store-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{ not json");
  const store = new JsonFileStore(file);
  assert.deepEqual(store.data, { version: 1, projects: {}, chats: {} });
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-")).length, 1);
});

test("target classification: General (1) and missing thread are the main view", () => {
  assert.deepEqual(targetFromMessage(5, {}), { chatId: 5 });
  assert.deepEqual(targetFromMessage(5, { message_thread_id: 1 }), { chatId: 5 });
  assert.deepEqual(targetFromMessage(5, { message_thread_id: 77 }), { chatId: 5, threadId: 77 });
  assert.deepEqual(threadParams({ chatId: 5 }), {});
  assert.deepEqual(threadParams({ chatId: 5, threadId: 1 }), {});
  assert.deepEqual(threadParams({ chatId: 5, threadId: 77 }), { message_thread_id: 77 });
  assert.equal(keyOf({ chatId: 5 }), undefined);
  assert.equal(keyOf({ chatId: 5, threadId: 77 }), "5:77");
});

test("topic names and titles", () => {
  assert.equal(topicName("  a\n b  "), "a b");
  assert.equal(topicName(""), "Session");
  assert.equal(topicName("x".repeat(200)).length, 128);
  assert.equal(titleFromPrompt("\n# Fix the login bug\nmore"), "Fix the login bug");
  const long = titleFromPrompt("Please refactor the authentication middleware so that tokens refresh");
  assert.ok(long.length <= 40 && long.endsWith("…"), long);
});

test("ChatBudget limits best-effort traffic per chat", () => {
  const b = new ChatBudget(2, 2);
  assert.equal(b.take(1, 0), true);
  assert.equal(b.take(1, 0), true);
  assert.equal(b.take(1, 0), false);
  assert.equal(b.take(2, 0), true, "other chats have their own budget");
  assert.equal(b.take(1, 600), true, "refills over time");
});

test("AccessControl allowlist and reply rate limit", () => {
  const a = new AccessControl(new Set([1]), 1000);
  assert.equal(a.isAllowed(1), true);
  assert.equal(a.isAllowed(2), false);
  assert.equal(a.isAllowed(undefined), false);
  assert.equal(a.shouldReply(2, 0), true);
  assert.equal(a.shouldReply(2, 500), false);
  assert.equal(a.shouldReply(2, 1500), true);
});

test("CommandRegistry resolves by place and builds one menu entry per name", () => {
  const r = new CommandRegistry<null>();
  const run = async () => {};
  r.register({ name: "help", scope: "both", description: "Help", run })
    .register({ name: "projects", scope: "main", description: "Projects", run })
    .register({ name: "status", scope: "main", description: "Status", run })
    .register({ name: "status", scope: "thread", description: "Status", run })
    .register({ name: "stop", scope: "thread", description: "Stop", run });
  assert.ok(r.resolve("help", "main") && r.resolve("help", "thread"));
  assert.equal(r.resolve("projects", "thread"), undefined);
  assert.equal(r.otherPlace("projects", "thread"), "main");
  assert.equal(r.otherPlace("stop", "main"), "thread");
  assert.equal(r.otherPlace("compact", "thread"), undefined);
  assert.notEqual(r.resolve("status", "main"), r.resolve("status", "thread"));
  assert.deepEqual(r.menu().map((m) => m.command), ["help", "projects", "status", "stop"]);
  assert.deepEqual(r.list("thread").map((d) => d.name), ["help", "status", "stop"]);
  assert.throws(() => r.register({ name: "stop", scope: "both", description: "x", run }), /twice/);
});

test("CallbackRouter dispatches by prefix", async () => {
  const router = new CallbackRouter<string[]>();
  router.on("pj", async (log, _ctx, payload) => void log.push(payload));
  const seen: string[] = [];
  const ctx = (data: string) => ({ callbackQuery: { data } }) as never;
  assert.equal(await router.dispatch(seen, ctx("pj:web")), true);
  assert.equal(await router.dispatch(seen, ctx("zz:x")), false);
  assert.deepEqual(seen, ["web"]);
  assert.throws(() => callbackData("x", "y".repeat(70)), /too long/);
});
