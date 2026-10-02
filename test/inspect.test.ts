import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { transcriptMarkdown } from "../src/app/inspect.ts";
import { commandKind } from "../src/claude/cmdnames.ts";
import { hooksView, instructionFiles, permissionsView, settingsSources } from "../src/claude/config-files.ts";
import { trackTasks } from "../src/claude/process.ts";
import { runProgram, type Exec } from "../src/core/exec.ts";
import type { ThreadRecord } from "../src/core/types.ts";
import { waitFor } from "./helpers/fake-process.ts";
import { harness, OWNER, type Call } from "./helpers/harness.ts";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const lastText = (h: ReturnType<typeof harness>, thread: number) => h.texts(h.inThread(thread)).at(-1) ?? "";
const buttons = (c: Call | undefined) =>
  ((c?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] })?.inline_keyboard ?? []).flat();

/** Start this chat's session by talking to it, and wait for the reply. */
async function talk(h: ReturnType<typeof harness>, thread: number, text = "hello"): Promise<void> {
  await h.send(text, { thread });
  await waitFor(() => h.texts(h.inThread(thread)).some((t) => t.includes(`reply: ${text}`)), 1000, `reply in ${thread}`);
}

// ---- classification --------------------------------------------------------------

test("commandKind: menu commands, bundled skills, own skills, hidden built-ins", () => {
  const bot = new Set(["status", "skills"]);
  assert.equal(commandKind({ name: "compact", builtin: true }, bot), "menu");
  assert.equal(commandKind({ name: "code-review", builtin: true }, bot), "skill");
  assert.equal(commandKind({ name: "my-skill" }, bot), "own-skill");
  assert.equal(commandKind({ name: "theme", builtin: true }, bot), "hidden");
  assert.equal(commandKind({ name: "status", builtin: true }, bot), "hidden", "the bot's own /status wins");
  assert.equal(commandKind({ name: "__remote-workflow", builtin: true }, bot), "hidden", "internal");
});

// ---- /skills, /agents ------------------------------------------------------------

test("/skills and /agents in a chat without a session ask a throwaway process and leave nothing behind", async () => {
  const h = harness();
  h.factory.onCreate = (p) => {
    p.commands = [{ name: "notes", description: "Take notes", argumentHint: "" }];
    p.agents = [{ name: "Explore", description: "Fast read-only search", model: "haiku" }];
  };
  await h.send("/skills", { thread: 600 });
  assert.match(lastText(h, 600), /\/notes — Take notes/);
  await h.send("/agents", { thread: 600 });
  assert.match(lastText(h, 600), /🤖 <b>Explore<\/b> · <code>haiku<\/code>\n {4}Fast read-only search/);
  assert.equal(h.factory.created.length, 2);
  assert.ok(h.factory.created.every((p) => p.closed && p.sent.length === 0), "probes closed, nothing sent");
  assert.equal(h.factory.created[0].spec.cwd, h.home, "probed in the active project");
  assert.equal(h.app.threads.get(`${OWNER}:600`), undefined, "no session record");
  assert.equal(h.app.pool.stats().live, 0, "no pool slot taken");
});

// ---- /mcp ------------------------------------------------------------------------

test("/mcp lists the session's servers with buttons that reconnect and toggle them", async () => {
  const h = harness();
  h.factory.onCreate = (p) => {
    p.mcp = [
      { name: "github", status: "connected", scope: "user", tools: [{ name: "a" }, { name: "b" }] },
      { name: "linear", status: "needs-auth", error: "401" },
    ];
  };
  await h.send("/mcp", { thread: 700 });
  const proc = h.factory.created[0];
  assert.ok(proc.started && !proc.closed, "the chat's own session process");
  assert.equal(proc.sent.length, 0, "nothing sent to Claude");
  const text = lastText(h, 700);
  assert.match(text, /🟢 <b>github<\/b> · connected · user · 2 tools/);
  assert.match(text, /🔑 <b>linear<\/b> · needs-auth/);
  assert.match(text, /Sign-in needed/);
  const msg = h.calls.filter((c) => c.method === "sendMessage").at(-1);
  assert.deepEqual(buttons(msg).map((b) => b.callback_data), ["mcp:r:0", "mcp:d:0", "mcp:r:1", "mcp:d:1"]);

  await h.press("mcp:d:0", 700);
  assert.deepEqual(proc.controls, ["toggle:github:false"]);
  const edit = h.calls.filter((c) => c.method === "editMessageText").at(-1)!;
  assert.match(String(edit.payload.text), /⏸ <b>github<\/b> · disabled/);
  assert.ok(buttons(edit).some((b) => b.callback_data === "mcp:e:0"), "now offers Enable");

  await h.send("/mcp reconnect all", { thread: 700 });
  assert.deepEqual(proc.controls.slice(1), ["reconnect:github", "reconnect:linear"]);
  await h.send("/mcp frobnicate x", { thread: 700 });
  assert.match(lastText(h, 700), /Usage: \/mcp/);
});

// ---- /tasks ----------------------------------------------------------------------

test("/tasks lists running background tasks with stop buttons; /bashes is an alias", async () => {
  const h = harness();
  await talk(h, 800);
  const proc = h.factory.created[0];
  await proc.emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      { task_id: "t1", task_type: "local_bash", description: "npm run dev" },
      { task_id: "t2", task_type: "monitor", description: "ambient watcher", ambient: true },
    ],
  });
  await h.send("/bashes", { thread: 800 });
  const text = lastText(h, 800);
  assert.match(text, /⚙️ <b>local_bash<\/b> · npm run dev · started/);
  assert.ok(!text.includes("ambient watcher"));
  await h.press("tk:0", 800);
  assert.deepEqual(proc.controls, ["stopTask:t1"]);
  assert.match(String(h.calls.filter((c) => c.method === "editMessageText").at(-1)!.payload.text), /No background tasks/);

  await h.send("/tasks", { thread: 801 });
  assert.match(lastText(h, 801), /No background tasks running/);
  assert.equal(h.factory.created.length, 1, "no process started just to look");
});

test("trackTasks keeps the first-seen time and drops ambient tasks", () => {
  const first = trackTasks([], [{ task_id: "a", task_type: "bash", description: "x" }], 1000);
  const next = trackTasks(first, [
    { task_id: "a", task_type: "bash", description: "x" },
    { task_id: "b", task_type: "agent", description: "y", ambient: true },
  ], 5000);
  assert.deepEqual(next, [{ id: "a", type: "bash", description: "x", since: 1000 }]);
});

// ---- /diff -----------------------------------------------------------------------

function gitRepo(dir: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "app.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "app.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n");
}

test("/diff summarises git changes in the chat's directory and sends the patch", async () => {
  const h = harness();
  await h.send("/diff", { thread: 900 });
  assert.match(lastText(h, 900), /is not a git repository/);

  gitRepo(h.home);
  await h.send("/diff", { thread: 900 });
  const text = lastText(h, 900);
  assert.match(text, /## (master|main)/);
  assert.match(text, /\?\? new\.txt/);
  assert.match(text, /app\.txt \| 1 \+/);
  const doc = h.calls.filter((c) => c.method === "sendDocument").at(-1)!;
  assert.equal(doc.payload.caption, "git diff HEAD");
  assert.equal(doc.payload.message_thread_id, 900);
});

test("/diff explains a missing git", async () => {
  const exec: Exec = async () => ({ code: 127, stdout: "", stderr: "git: not found", truncated: false });
  const h = harness({ exec });
  await h.send("/diff", { thread: 901 });
  assert.match(lastText(h, 901), /git is not installed/);
});

// ---- /export ---------------------------------------------------------------------

test("transcriptMarkdown merges turns, keeps text and summarises tool calls", () => {
  const record = { title: "Fix login", sessionId: "s-1", cwd: "/w" } as ThreadRecord;
  const md = transcriptMarkdown(
    record,
    [
      { role: "user", text: "why does login fail?", tools: [] },
      { role: "assistant", text: "Let me look.", tools: [{ name: "Bash", input: { command: "npm test" } }] },
      { role: "assistant", text: "Found it.", tools: [] },
    ],
    new Date("2026-10-02T00:00:00Z"),
  );
  assert.equal(
    md,
    "# Fix login\n\nSession `s-1` · `/w` · exported 2026-10-02T00:00:00.000Z\n\n## You\n\nwhy does login fail?\n\n" +
      "## Claude\n\nLet me look.\n\n> 💻 Bash: npm test\n\nFound it.\n",
  );
});

test("/export sends the conversation as a file once there is one", async () => {
  const h = harness();
  await h.send("/export", { thread: 1000 });
  assert.match(lastText(h, 1000), /Nothing to export yet/);
  await talk(h, 1000, "first");
  h.app.sessions.transcript = async () => [
    { role: "user", text: "first", tools: [] },
    { role: "assistant", text: "reply: first", tools: [] },
  ];
  await h.send("/export", { thread: 1000 });
  const doc = h.calls.filter((c) => c.method === "sendDocument").at(-1)!;
  assert.equal(doc.payload.caption, "2 messages");
});

// ---- /plan, /branch ----------------------------------------------------------------

test("/plan switches the chat to plan mode and sends the task", async () => {
  const h = harness();
  await h.send("/plan add a cache layer", { thread: 1100 });
  assert.equal(h.app.threads.get(`${OWNER}:1100`)!.permissionMode, "plan");
  await waitFor(() => h.factory.created.length === 1 && h.factory.created[0].sent.length === 1, 1000, "task sent");
  assert.equal(h.factory.created[0].spec.permissionMode, "plan");
  assert.equal(h.factory.created[0].sent[0], "add a cache layer");
  assert.ok(h.texts(h.inThread(1100)).some((t) => t.includes("Plan mode on")));
});

test("/branch forks like /fork", async () => {
  const h = harness();
  await talk(h, 1200);
  await h.send("/branch", { thread: 1200 });
  assert.ok(h.calls.some((c) => c.method === "createForumTopic"));
  assert.match(lastText(h, 1200), /Forked into a new chat/);
});

// ---- /memory, /permissions, /hooks --------------------------------------------------

test("instructionFiles: managed, user, then root-to-cwd; AGENTS.md only where there is no CLAUDE.md", () => {
  const root = tmp("tgcc-mem-");
  const home = path.join(root, "home");
  const managed = path.join(root, "managed");
  const proj = path.join(root, "work", "proj");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.mkdirSync(managed);
  fs.writeFileSync(path.join(managed, "CLAUDE.md"), "m");
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "u");
  fs.writeFileSync(path.join(root, "work", "AGENTS.md"), "parent agents");
  fs.writeFileSync(path.join(proj, "CLAUDE.md"), "p");
  fs.writeFileSync(path.join(proj, "AGENTS.md"), "ignored: CLAUDE.md wins");
  fs.writeFileSync(path.join(proj, "CLAUDE.local.md"), "local");
  const files = instructionFiles(home, proj, managed).filter((f) => f.path.startsWith(root));
  assert.deepEqual(
    files.map((f) => [f.scope, path.relative(root, f.path)]),
    [
      ["managed", path.join("managed", "CLAUDE.md")],
      ["user", path.join("home", ".claude", "CLAUDE.md")],
      ["project", path.join("work", "AGENTS.md")],
      ["project", path.join("work", "proj", "CLAUDE.md")],
      ["project", path.join("work", "proj", "CLAUDE.local.md")],
    ],
  );
});

test("settings views: sources in precedence order, permissions and hooks with their source", () => {
  const root = tmp("tgcc-set-");
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }] },
    }),
  );
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), "{ not json");
  const sources = settingsSources(home, cwd, path.join(root, "none"));
  assert.deepEqual(sources.map((s) => s.scope), ["local", "user"], "unreadable files are skipped");
  const perms = permissionsView(sources);
  assert.equal(perms[0].defaultMode, "acceptEdits");
  assert.deepEqual(perms[1].allow, ["Bash(npm test)"]);
  assert.deepEqual(perms[1].deny, ["Read(./.env)"]);
  const hooks = hooksView(sources);
  assert.deepEqual(hooks.map((x) => [x.source.scope, x.event, x.matcher, x.commands]), [["user", "PreToolUse", "Bash", ["audit.sh"]]]);
});

test("/memory lists the instruction files of the chat's directory and sends one", async () => {
  const h = harness();
  fs.writeFileSync(path.join(h.home, "CLAUDE.md"), "# Rules\n");
  await h.send("/memory", { thread: 1300 });
  assert.ok(lastText(h, 1300).includes(path.join(h.home, "CLAUDE.md")));
  const n = instructionFiles(os.homedir(), h.home).findIndex((f) => f.path === path.join(h.home, "CLAUDE.md")) + 1;
  await h.send(`/memory ${n}`, { thread: 1300 });
  const doc = h.calls.filter((c) => c.method === "sendDocument").at(-1)!;
  assert.equal(doc.payload.caption, path.join(h.home, "CLAUDE.md"));
  await h.send("/memory 999", { thread: 1300 });
  assert.match(lastText(h, 1300), /Usage: \/memory/);
});

test("/permissions and /hooks show the project's settings", async () => {
  const h = harness();
  fs.mkdirSync(path.join(h.home, ".claude"));
  fs.writeFileSync(
    path.join(h.home, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }] },
    }),
  );
  await h.send("/permissions", { thread: 1400 });
  const perms = lastText(h, 1400);
  assert.match(perms, /<b>project<\/b>/);
  assert.match(perms, /✅ allow: <code>Bash\(npm test\)<\/code>/);
  await h.send("/hooks", { thread: 1400 });
  assert.match(lastText(h, 1400), /• <b>Stop<\/b> <code>\*<\/code> → <code>notify\.sh<\/code>/);
});

// ---- /plugin ---------------------------------------------------------------------

test("/plugin runs `claude plugin …` and reloads the chat's session after a change", async () => {
  const runs: { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (file, args, opts) => {
    runs.push({ file, args, cwd: opts.cwd, env: opts.env });
    return { code: 0, stdout: args.includes("list") ? "formatter@tools  enabled" : "Installed", stderr: "", truncated: false };
  };
  const h = harness({ exec });
  (h.app.cfg as { claudePath?: string }).claudePath = "/opt/claude";
  await h.send("/plugin", { thread: 1500 });
  assert.deepEqual(runs[0].args, ["plugin", "list"]);
  assert.equal(runs[0].file, "/opt/claude");
  assert.equal(runs[0].env?.DISABLE_AUTOUPDATER, "1");
  assert.equal("TELEGRAM_BOT_TOKEN" in (runs[0].env ?? {}), false);
  assert.match(lastText(h, 1500), /<pre>formatter@tools {2}enabled<\/pre>/);

  await talk(h, 1500);
  await h.send("/plugin install formatter@tools", { thread: 1500 });
  assert.deepEqual(runs[1].args, ["plugin", "install", "formatter@tools"]);
  assert.deepEqual(h.factory.created[0].controls, ["reloadPlugins"]);
  assert.match(lastText(h, 1500), /Reloaded in this chat's session/);

  await h.send("/plugin rm formatter", { thread: 1500 });
  assert.match(lastText(h, 1500), /Usage: \/plugin/);
  assert.equal(runs.length, 2, "nothing run for an unknown subcommand");
});

// ---- /help, exec -------------------------------------------------------------------

test("/help lists Claude Code's menu commands and points to /skills", async () => {
  const h = harness();
  await h.send("/help", { thread: 1600 });
  const text = lastText(h, 1600);
  assert.match(text, /<b>Claude Code<\/b>\n\/compact/);
  assert.match(text, /\/skills lists them/);
  assert.match(text, /\/mcp/);
  assert.ok(text.length < 4096, `help fits one Telegram message (${text.length} chars)`);
});

test("runProgram: exit codes, missing programs and time limits", async () => {
  const ok = await runProgram(process.execPath, ["-e", "process.stdout.write('hi')"], { timeoutMs: 10_000 });
  assert.deepEqual([ok.code, ok.stdout], [0, "hi"]);
  const missing = await runProgram("definitely-not-a-program-xyz", [], { timeoutMs: 5000 });
  assert.equal(missing.code, 127);
  const slow = await runProgram(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 300 });
  assert.equal(slow.code, -1);
  const big = await runProgram(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { timeoutMs: 10_000, maxBytes: 100 });
  assert.equal(big.stdout.length, 100);
  assert.equal(big.truncated, true);
});
