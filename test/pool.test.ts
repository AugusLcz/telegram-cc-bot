import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProcessSpec } from "../src/claude/process.ts";
import { SessionPool, StartCancelledError, type ExitReason, type PoolPolicy } from "../src/claude/pool.ts";
import { FakeFactory, tick, waitFor } from "./helpers/fake-process.ts";

function setup(policy: Partial<PoolPolicy> = {}) {
  const factory = new FakeFactory();
  const exits: [string, ExitReason][] = [];
  const waiting: string[] = [];
  const pool = new SessionPool(
    factory,
    { maxLive: 2, idleMs: 10_000, backgroundMaxMs: 10_000, ...policy },
    {
      canUseTool: () => async () => ({ behavior: "allow" }),
      onMessage: async () => {},
      onExit: (key, reason) => exits.push([key, reason]),
      onWaiting: (key) => waiting.push(key),
    },
  );
  const spec = (id: string, extra: Partial<ProcessSpec> = {}) => () =>
    ({ sessionId: id, resume: false, cwd: "/w", permissionMode: "default", ...extra }) as ProcessSpec;
  return { factory, pool, exits, waiting, spec };
}

test("starts lazily on first send and reuses the process", async () => {
  const { factory, pool, spec } = setup();
  assert.equal(pool.state("a"), "cold");
  await pool.send("a", spec("s1"), "hi");
  assert.equal(factory.created.length, 1);
  assert.equal(pool.state("a"), "busy");
  await factory.last().finishTurn();
  assert.equal(pool.state("a"), "idle");
  await pool.send("a", spec("s1"), "again");
  assert.equal(factory.created.length, 1);
  assert.deepEqual(factory.last().sent, ["hi", "again"]);
});

test("concurrent sends for one key create a single process", async () => {
  const { factory, pool, spec } = setup();
  factory.startDelayMs = 20;
  await Promise.all([pool.send("a", spec("s1"), "1"), pool.send("a", spec("s1"), "2")]);
  assert.equal(factory.created.length, 1);
  assert.deepEqual(factory.last().sent, ["1", "2"]);
});

test("evicts the least recently used idle process when full", async () => {
  const { factory, pool, exits, spec } = setup({ maxLive: 2 });
  await pool.send("a", spec("sa"), "x");
  const a = factory.last();
  await a.finishTurn();
  await tick(2);
  await pool.send("b", spec("sb"), "x");
  await factory.last().finishTurn();
  await pool.send("c", spec("sc"), "x");
  await waitFor(() => a.closed, 500, "a closed");
  assert.deepEqual(exits, [["a", "evicted"]]);
  assert.equal(pool.state("a"), "cold");
  assert.equal(pool.state("b"), "idle");
  assert.equal(pool.state("c"), "busy");
  assert.equal(pool.stats().live, 2);
});

test("never evicts busy sessions; a new start waits for a free slot", async () => {
  const { factory, pool, exits, waiting, spec } = setup({ maxLive: 1 });
  await pool.send("a", spec("sa"), "x"); // busy
  const a = factory.last();
  let started = false;
  const pending = pool.send("b", spec("sb"), "y").then(() => (started = true));
  await tick(10);
  assert.equal(started, false);
  assert.deepEqual(waiting, ["b"]);
  assert.equal(pool.state("b"), "starting");
  await a.finishTurn(); // a turns idle → handed over to the waiter
  await pending;
  assert.equal(started, true);
  assert.ok(a.closed);
  assert.deepEqual(exits, [["a", "evicted"]]);
  assert.deepEqual(factory.last().sent, ["y"]);
});

test("pending prompts and background tasks keep a session busy", async () => {
  const { factory, pool, spec } = setup({ maxLive: 1 });
  await pool.send("a", spec("sa"), "x");
  const a = factory.last();
  pool.setBlocked("a", 1);
  await a.finishTurn();
  assert.equal(pool.state("a"), "busy");
  pool.setBlocked("a", -1);
  assert.equal(pool.state("a"), "idle");
  await a.emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t", ambient: false }] });
  assert.equal(pool.state("a"), "busy");
  await a.emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w", ambient: true }] });
  assert.equal(pool.state("a"), "idle");
});

test("closes idle processes after the idle TTL", async () => {
  const { factory, pool, exits, spec } = setup({ idleMs: 30 });
  await pool.send("a", spec("sa"), "x");
  await factory.last().finishTurn();
  await waitFor(() => exits.length === 1, 500, "idle exit");
  assert.deepEqual(exits, [["a", "idle"]]);
  assert.ok(factory.last().closed);
});

test("a new message resets the idle timer", async () => {
  const { factory, pool, exits, spec } = setup({ idleMs: 40 });
  await pool.send("a", spec("sa"), "x");
  await factory.last().finishTurn();
  await tick(25);
  await pool.send("a", spec("sa"), "y");
  await tick(25);
  await factory.last().finishTurn();
  await tick(25);
  assert.equal(exits.length, 0);
  await waitFor(() => exits.length === 1, 500, "idle exit");
});

test("background work is capped by backgroundMaxMs", async () => {
  const { factory, pool, exits, spec } = setup({ idleMs: 10, backgroundMaxMs: 40 });
  await pool.send("a", spec("sa"), "x");
  const a = factory.last();
  await a.emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t" }] });
  await a.finishTurn();
  await tick(20);
  assert.equal(exits.length, 0, "idle TTL must not apply while background work runs");
  await waitFor(() => exits.length === 1, 500, "background exit");
  assert.deepEqual(exits, [["a", "background-limit"]]);
});

test("crash makes the session cold and the next send starts a fresh process from the latest spec", async () => {
  const { factory, pool, exits, spec } = setup();
  await pool.send("a", spec("sa"), "x");
  factory.last().crash();
  assert.equal(pool.state("a"), "cold");
  assert.deepEqual(exits, [["a", "crash"]]);
  await pool.send("a", spec("sa", { resume: true, model: "opus" }), "y");
  assert.equal(factory.created.length, 2);
  assert.equal(factory.last().spec.resume, true);
  assert.equal(factory.last().spec.model, "opus");
});

test("spec is read when the process actually starts", async () => {
  const { factory, pool } = setup({ maxLive: 1 });
  let model = "sonnet";
  const specFn = (id: string) => () => ({ sessionId: id, resume: false, cwd: "/w", permissionMode: "default", model }) as ProcessSpec;
  await pool.send("a", specFn("sa"), "x");
  const pending = pool.send("b", specFn("sb"), "y");
  model = "opus"; // changed while b waits for a slot
  await factory.created[0].finishTurn();
  await pending;
  assert.equal(factory.last().spec.model, "opus");
});

test("cancelWaiting rejects the waiting start and frees its place", async () => {
  const { factory, pool, spec } = setup({ maxLive: 1 });
  await pool.send("a", spec("sa"), "x");
  const pending = pool.send("b", spec("sb"), "y");
  await tick(5);
  assert.equal(pool.cancelWaiting("b"), true);
  await assert.rejects(pending, StartCancelledError);
  assert.equal(pool.state("b"), "cold");
  assert.equal(pool.stats().waiting, 0);
  assert.equal(factory.created.length, 1);
});

test("failed start releases the slot", async () => {
  const { factory, pool, spec } = setup({ maxLive: 1 });
  factory.failNextStart = new Error("No conversation found");
  await assert.rejects(pool.send("a", spec("sa"), "x"), /No conversation found/);
  assert.equal(pool.state("a"), "cold");
  await pool.send("b", spec("sb"), "y");
  assert.equal(pool.state("b"), "busy");
});

test("hibernate closes a live process; interrupt only when a turn runs", async () => {
  const { factory, pool, exits, spec } = setup();
  await pool.send("a", spec("sa"), "x");
  assert.equal(await pool.interrupt("a"), true);
  assert.equal(factory.last().interrupts, 1);
  assert.equal(await pool.interrupt("a"), false);
  await pool.hibernate("a");
  assert.deepEqual(exits, [["a", "closed"]]);
  assert.equal(pool.state("a"), "cold");
  assert.equal(await pool.interrupt("a"), false);
});

test("shutdown closes every process and rejects waiters", async () => {
  const { factory, pool, exits, spec } = setup({ maxLive: 1 });
  await pool.send("a", spec("sa"), "x");
  const pending = pool.send("b", spec("sb"), "y");
  await tick(5);
  await pool.shutdown();
  await assert.rejects(pending, StartCancelledError);
  assert.ok(factory.created[0].closed);
  assert.deepEqual(exits, [["a", "shutdown"]]);
  assert.equal(pool.stats().live, 0);
});
