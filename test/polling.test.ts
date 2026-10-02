import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerHandle } from "@grammyjs/runner";
import { GrammyError, type Bot } from "grammy";
import { claudeEnv, SESSION_FLAG_SETTINGS } from "../src/claude/process.ts";
import type { Logger } from "../src/core/logger.ts";
import { defaultConflictDelay, Poller } from "../src/telegram/polling.ts";
import { waitFor } from "./helpers/fake-process.ts";

function apiError(code: number, description: string): GrammyError {
  return new GrammyError(`Call to 'getUpdates' failed! (${code}: ${description})`, { ok: false, error_code: code, description }, "getUpdates", {});
}

/** A runner whose task fails with the next queued error, or keeps running when none is queued. */
function fakeRunner(errors: unknown[]) {
  const starts: number[] = [];
  const runFn = (): RunnerHandle => {
    starts.push(Date.now());
    const err = errors.shift();
    let running = true;
    const task = err === undefined ? new Promise<void>(() => {}) : Promise.reject(err).finally(() => (running = false));
    return {
      task: () => task,
      isRunning: () => running,
      stop: async () => {
        running = false;
      },
    } as unknown as RunnerHandle;
  };
  return { runFn, starts };
}

function recordingLog(lines: string[]): Logger {
  const rec = (msg: string) => void lines.push(msg);
  const log: Logger = { debug: rec, info: rec, warn: rec, error: rec, child: () => log };
  return log;
}

test("a 409 conflict is logged and retried with backoff instead of crashing", async () => {
  const { runFn, starts } = fakeRunner([apiError(409, "Conflict: terminated by other getUpdates request"), apiError(409, "Conflict")]);
  const lines: string[] = [];
  let fatal = false;
  const poller = new Poller({} as Bot, {
    runFn,
    log: recordingLog(lines),
    onFatal: () => (fatal = true),
    conflictDelay: (n) => n * 0.02,
  });
  poller.start();
  await waitFor(() => starts.length === 3, 1000, "two retries");
  assert.equal(fatal, false);
  assert.equal(poller.conflictCount, 2);
  assert.ok(lines.every((l) => l.includes("409: Conflict")), "log keeps the marker deploy.sh looks for");
  assert.ok(poller.isRunning());
  await poller.stop();
});

test("a webhook set meanwhile is removed and polling resumes, without counting as a conflict", async () => {
  const { runFn, starts } = fakeRunner([
    apiError(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"),
  ]);
  let deleted = 0;
  const bot = { api: { deleteWebhook: async () => ((deleted += 1), true) } } as unknown as Bot;
  const poller = new Poller(bot, { runFn, onFatal: () => assert.fail("fatal"), errorDelay: 0.02 });
  poller.start();
  await waitFor(() => starts.length === 2, 1000, "retry");
  assert.equal(deleted, 1);
  assert.equal(poller.conflictCount, 0);
  await poller.stop();
});

test("a rejected token (401) is fatal and not retried", async () => {
  const { runFn, starts } = fakeRunner([apiError(401, "Unauthorized")]);
  let fatal: unknown;
  const poller = new Poller({} as Bot, { runFn, onFatal: (err) => (fatal = err), conflictDelay: () => 0.01 });
  poller.start();
  await waitFor(() => fatal !== undefined, 1000, "fatal");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(starts.length, 1);
});

test("other polling failures are retried; stop() cancels a pending retry", async () => {
  const { runFn, starts } = fakeRunner([new Error("network down")]);
  const poller = new Poller({} as Bot, { runFn, onFatal: () => {}, errorDelay: 0.05 });
  poller.start();
  await new Promise((r) => setTimeout(r, 10));
  await poller.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(starts.length, 1, "no restart after stop()");
});

test("conflict backoff grows to five minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(defaultConflictDelay), [15, 30, 60, 120, 240, 300]);
});

test("Claude Code processes never see the bot token", () => {
  const env = claudeEnv({ TELEGRAM_BOT_TOKEN: "123:secret", PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-x" });
  assert.equal("TELEGRAM_BOT_TOKEN" in env, false);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-x", "Claude's own login token is kept");
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "tg-cc-bot");
});

test("sessions started by the bot never load Claude Code's own Telegram poller", () => {
  assert.equal(SESSION_FLAG_SETTINGS.enabledPlugins["telegram@claude-plugins-official"], false);
});
