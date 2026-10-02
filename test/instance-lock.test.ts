import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireInstanceLock, AlreadyRunningError } from "../src/core/instance-lock.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tgcc-lock-"));

test("a second instance for the same bot is refused while the first runs", async () => {
  const dir = tmp();
  // A live process standing in for the running bot (its command line mentions index.ts).
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", "index.ts"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(dir, "tg-cc-bot-42.lock"), String(other.pid));
    assert.throws(() => acquireInstanceLock(42, dir), (err) => err instanceof AlreadyRunningError && err.pid === other.pid);
    const differentBot = acquireInstanceLock(43, dir);
    differentBot.release();
  } finally {
    other.kill();
  }
});

test("a stale lock (dead process) is taken over and released on exit", () => {
  const dir = tmp();
  const file = path.join(dir, "tg-cc-bot-42.lock");
  fs.writeFileSync(file, "999999"); // no such process
  const lock = acquireInstanceLock(42, dir);
  assert.equal(fs.readFileSync(file, "utf8"), String(process.pid));
  lock.release();
  assert.equal(fs.existsSync(file), false);
});

test("an empty lock (released where it could not be deleted) counts as stale", () => {
  const dir = tmp();
  const file = path.join(dir, "tg-cc-bot-42.lock");
  fs.writeFileSync(file, "");
  const lock = acquireInstanceLock(42, dir);
  assert.equal(fs.readFileSync(file, "utf8"), String(process.pid));
  lock.release();
});

test("release never removes another process's lock", () => {
  const dir = tmp();
  const lock = acquireInstanceLock(7, dir);
  fs.writeFileSync(lock.file, "123456");
  lock.release();
  assert.equal(fs.readFileSync(lock.file, "utf8"), "123456");
});
