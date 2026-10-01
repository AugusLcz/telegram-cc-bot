import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncQueue } from "../src/core/queue.ts";

test("delivers items pushed before and after the consumer waits", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  const seen: number[] = [];
  const done = (async () => {
    for await (const n of q) seen.push(n);
  })();
  await new Promise((r) => setTimeout(r, 5));
  q.push(2);
  q.push(3);
  q.close();
  await done;
  assert.deepEqual(seen, [1, 2, 3]);
});

test("push after close throws", () => {
  const q = new AsyncQueue<number>();
  q.close();
  assert.throws(() => q.push(1));
});
