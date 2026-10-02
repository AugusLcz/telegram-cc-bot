import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionPool } from "../src/claude/pool.ts";
import type { SessionApi, SessionInfo } from "../src/claude/sessions.ts";
import type { Target } from "../src/core/types.ts";
import { ChatService, claimStateForBot } from "../src/domain/chats.ts";
import { UserError } from "../src/domain/errors.ts";
import { ProjectService } from "../src/domain/projects.ts";
import { ThreadService, type TopicGateway } from "../src/domain/threads.ts";
import { MemoryStore } from "../src/store/store.ts";
import { titleFromPrompt } from "../src/telegram/topics.ts";
import { FakeFactory } from "./helpers/fake-process.ts";

class FakeTopics implements TopicGateway {
  next = 900; // far from the chat IDs the tests bind by hand
  created: { chatId: number; threadId: number; name: string }[] = [];
  renamed: { target: Target; name: string }[] = [];
  removed: Target[] = [];
  async create(chatId: number, name: string) {
    const threadId = this.next++;
    this.created.push({ chatId, threadId, name });
    return threadId;
  }
  async rename(target: Target, name: string) {
    this.renamed.push({ target, name });
  }
  async remove(target: Target) {
    this.removed.push(target);
  }
}

class FakeSessions implements SessionApi {
  infos = new Map<string, SessionInfo>();
  renamed: [string, string][] = [];
  forks = 0;
  async list() {
    return [...this.infos.values()];
  }
  async info(id: string) {
    return this.infos.get(id);
  }
  async fork(id: string) {
    return `${id}-fork${++this.forks}`;
  }
  async rename(id: string, title: string) {
    this.renamed.push([id, title]);
  }
  async recap() {
    return {};
  }
}

const CHAT = 42;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tgcc-proj-"));
  const web = path.join(root, "web");
  const api = path.join(root, "api");
  fs.mkdirSync(web);
  fs.mkdirSync(api);
  const store = new MemoryStore();
  const chats = new ChatService(store, () => ({ permissionMode: "auto", verbose: false }));
  const projects = new ProjectService(store, chats, { allowedRoots: [root], isWritable: () => true });
  projects.bootstrap(web);
  const factory = new FakeFactory();
  const pool = new SessionPool(factory, { maxLive: 2, idleMs: 60_000, backgroundMaxMs: 60_000 }, {
    canUseTool: () => async () => ({ behavior: "allow" }),
    onMessage: async (key, msg) => threads.observe(key, msg),
    onExit: () => {},
  });
  const topics = new FakeTopics();
  const sessions = new FakeSessions();
  let n = 0;
  const threads = new ThreadService({
    store,
    chats,
    projects,
    pool,
    topics,
    sessions,
    titleFromPrompt,
    newSessionId: () => `sess-${++n}`,
  });
  return { root, web, api, store, chats, projects, factory, pool, topics, sessions, threads };
}

test("bindTab binds a new chat to a fresh session in the active project", () => {
  const { threads, topics, web } = setup();
  const tab = threads.bindTab(CHAT, 100);
  assert.equal(tab.key, `${CHAT}:100`);
  assert.equal(tab.created, true);
  assert.equal(topics.created.length, 0, "the chat already exists in Telegram");
  assert.equal(tab.record.project, "home");
  assert.equal(tab.record.cwd, web);
  assert.equal(tab.record.started, false);
  assert.equal(tab.record.titleSource, "placeholder");
  assert.equal(tab.record.permissionMode, "auto");
  const titled = threads.bindTab(CHAT, 101, "Bug hunt");
  assert.equal(titled.record.titleSource, "user");
  assert.notEqual(titled.record.sessionId, tab.record.sessionId);
});

test("new tabs follow the active project; existing tabs keep their cwd", async () => {
  const { threads, projects, api } = setup();
  const first = threads.bindTab(CHAT, 100);
  projects.add("api", api);
  projects.use(CHAT, "api");
  const plus = threads.bindTab(CHAT, 555, "From plus", false);
  assert.equal(plus.created, true);
  assert.equal(plus.record.project, "api");
  assert.equal(plus.record.cwd, api);
  assert.equal(threads.get(first.key)!.project, "home");
  assert.equal(threads.bindTab(CHAT, 555).created, false, "binding is idempotent");
  assert.equal(threads.bindTab(CHAT, 556, "Topic", true).record.titleSource, "placeholder", "implicit names get auto-titled");
});

test("first send creates the session, later sends resume it with persisted settings", async () => {
  const { threads, factory, pool } = setup();
  const tab = threads.bindTab(CHAT, 100);
  await threads.send(tab.key, "hello", "hello");
  const p1 = factory.last();
  assert.equal(p1.spec.resume, false);
  assert.equal(p1.spec.sessionId, tab.record.sessionId);
  await p1.emit({ type: "system", subtype: "init", session_id: tab.record.sessionId, model: "m" });
  await p1.finishTurn();
  assert.equal(threads.get(tab.key)!.started, true);

  await threads.setModel(tab.key, "opus");
  assert.equal(p1.model, "opus", "applied live");
  await threads.setEffort(tab.key, "high");
  await pool.hibernate(tab.key);
  await threads.send(tab.key, "again");
  const p2 = factory.last();
  assert.notEqual(p2, p1);
  assert.equal(p2.spec.resume, true);
  assert.equal(p2.spec.model, "opus");
  assert.equal(p2.spec.effort, "high");
});

test("auto-title on the first prompt; user titles are never overwritten", async () => {
  const { threads, topics, sessions, factory } = setup();
  const tab = threads.bindTab(CHAT, 100);
  await threads.send(tab.key, "Fix the flaky login test\nmore details", "Fix the flaky login test\nmore details");
  assert.equal(threads.get(tab.key)!.title, "Fix the flaky login test");
  assert.deepEqual(topics.renamed.map((r) => r.name), ["Fix the flaky login test"]);
  await factory.last().finishTurn();
  await threads.send(tab.key, "second prompt", "second prompt");
  assert.equal(topics.renamed.length, 1, "only the first prompt titles the tab");

  const named = threads.bindTab(CHAT, 101, "Mine");
  await threads.send(named.key, "something", "something");
  assert.equal(threads.get(named.key)!.title, "Mine");

  await threads.topicRenamed(tab.key, "Renamed in Telegram");
  assert.equal(threads.get(tab.key)!.titleSource, "user");
  assert.equal(sessions.renamed.length, 0, "unstarted sessions are not renamed on disk");
});

test("resumeIntoTab opens a new tab once and reuses it afterwards", async () => {
  const { threads, sessions, topics, api } = setup();
  sessions.infos.set("cli-1", { sessionId: "cli-1", summary: "CLI work", lastModified: 1, cwd: api });
  const first = await threads.resumeIntoTab(CHAT, "cli-1");
  assert.equal(first.existed, false);
  assert.equal(first.record.started, true);
  assert.equal(first.record.cwd, api);
  assert.equal(first.record.project, "-", "directories that are not projects still work");
  assert.equal(topics.created.at(-1)!.name, "CLI work");
  const again = await threads.resumeIntoTab(CHAT, "cli-1");
  assert.equal(again.existed, true);
  assert.equal(again.key, first.key);
  await assert.rejects(threads.resumeIntoTab(CHAT, "missing"), UserError);
});

test("forkTab needs a started session and opens the fork in a new tab", async () => {
  const { threads, factory } = setup();
  const tab = threads.bindTab(CHAT, 100, "Base");
  await assert.rejects(threads.forkTab(tab.key), UserError);
  await threads.send(tab.key, "x");
  await factory.last().emit({ type: "system", subtype: "init", session_id: tab.record.sessionId });
  const fork = await threads.forkTab(tab.key);
  assert.equal(fork.record.sessionId, `${tab.record.sessionId}-fork1`);
  assert.equal(fork.record.started, true);
  assert.equal(fork.record.title, "Base (fork)");
  assert.notEqual(fork.key, tab.key);
});

test("a missing transcript falls back to a fresh session", async () => {
  const { threads, factory, store } = setup();
  const tab = threads.bindTab(CHAT, 100);
  store.update(() => {
    tab.record.started = true;
  });
  factory.failNextStart = new Error("No conversation found with session ID: sess-1");
  const outcome = await threads.send(tab.key, "hi");
  assert.equal(outcome.freshSession, true);
  const record = threads.get(tab.key)!;
  assert.notEqual(record.sessionId, "sess-1");
  assert.equal(factory.last().spec.resume, false);
});

test("conversation_reset rebinds the tab to the new session", async () => {
  const { threads, factory } = setup();
  const tab = threads.bindTab(CHAT, 100);
  await threads.send(tab.key, "/clear");
  await factory.last().emit({ type: "conversation_reset", new_conversation_id: "after-clear" });
  assert.equal(threads.get(tab.key)!.sessionId, "after-clear");
  assert.equal(threads.findBySession("after-clear")?.key, tab.key);
});

test("deleteTab hibernates, removes the topic and forgets the tab", async () => {
  const { threads, factory, topics, pool } = setup();
  const tab = threads.bindTab(CHAT, 100);
  await threads.send(tab.key, "x");
  await threads.deleteTab(tab.key);
  assert.ok(factory.last().closed);
  assert.equal(pool.state(tab.key), "cold");
  assert.deepEqual(topics.removed, [{ chatId: CHAT, threadId: 100 }]);
  assert.equal(threads.get(tab.key), undefined);
});

test("projects: validation, removal and the active project", () => {
  const { projects, root, api } = setup();
  assert.throws(() => projects.add("bad name", api), UserError);
  assert.throws(() => projects.add("x", path.join(root, "nope")), /Not a directory/);
  assert.throws(() => projects.add("tmp", os.tmpdir()), /outside ALLOWED_ROOTS/);
  projects.add("api", api);
  assert.throws(() => projects.add("api", api), /already exists/);
  projects.use(CHAT, "api");
  assert.equal(projects.activeFor(CHAT).name, "api");
  projects.remove("api");
  assert.equal(projects.activeFor(CHAT).name, "home", "chats fall back to a remaining project");
  assert.throws(() => projects.remove("home"), /at least one/);
});

test("mode changes made by Claude itself are persisted for the next resume", async () => {
  const { threads, factory } = setup();
  const tab = threads.bindTab(CHAT, 100);
  await threads.send(tab.key, "plan it");
  await factory.last().emit({ type: "system", subtype: "status", status: null, permissionMode: "default" });
  assert.equal(threads.get(tab.key)!.permissionMode, "default");
});

test("a chat can switch project only until its session starts", async () => {
  const { threads, projects, factory, api } = setup();
  const other = projects.add("api", api);
  const tab = threads.bindTab(CHAT, 100);
  assert.equal(threads.setProject(tab.key, other), true);
  assert.equal(threads.get(tab.key)!.cwd, api);
  await threads.send(tab.key, "go");
  await factory.last().emit({ type: "system", subtype: "init", session_id: tab.record.sessionId });
  assert.equal(threads.setProject(tab.key, projects.get("home")!), false, "started sessions keep their directory");
  assert.equal(threads.get(tab.key)!.cwd, api);
  assert.equal(threads.setProject(`${CHAT}:555`, other), true, "unknown chats bind to the active project later");
});

test("pruneEmpty forgets only old chats that never started a session", async () => {
  const { threads, factory, store } = setup();
  const empty = threads.bindTab(CHAT, 100);
  const fresh = threads.bindTab(CHAT, 101);
  const used = threads.bindTab(CHAT, 102);
  await threads.send(used.key, "x");
  await factory.last().emit({ type: "system", subtype: "init", session_id: used.record.sessionId });
  store.update(() => {
    empty.record.lastActiveAt = 0;
    used.record.lastActiveAt = 0;
  });
  assert.equal(threads.pruneEmpty(60_000), 1);
  assert.equal(threads.get(empty.key), undefined);
  assert.ok(threads.get(fresh.key), "recent empty chats stay");
  assert.ok(threads.get(used.key), "chats with a session stay");
});

test("a bot switch puts chat bindings aside and a switch back restores them; an old state is kept", () => {
  const store = new MemoryStore();
  store.update((d) => {
    d.projects.home = { name: "home", path: "/w", addedAt: 0 };
    d.chats["42"] = {
      activeProject: "home",
      defaults: { permissionMode: "auto", verbose: false },
      threads: { "5": { threadId: 5, sessionId: "s-a" } as never, "6": { threadId: 6, sessionId: "s-a2" } as never },
    };
  });
  assert.deepEqual(claimStateForBot(store, 111), { archived: 0, restored: 0 }, "state from before the bot was recorded: kept");
  assert.equal(Object.keys(store.data.chats["42"].threads).length, 2);
  assert.equal(store.data.botId, 111);
  assert.deepEqual(claimStateForBot(store, 111), { archived: 0, restored: 0 }, "same bot: nothing changes");

  assert.deepEqual(claimStateForBot(store, 222), { archived: 2, restored: 0 }, "token switched to another bot");
  assert.deepEqual(store.data.chats["42"].threads, {});
  assert.equal(store.data.chats["42"].activeProject, "home", "projects and defaults stay");
  store.update((d) => {
    d.chats["42"].threads["5"] = { threadId: 5, sessionId: "s-b" } as never;
  });

  assert.deepEqual(claimStateForBot(store, 111), { archived: 1, restored: 2 }, "switched back");
  assert.equal(store.data.chats["42"].threads["5"].sessionId, "s-a");
  assert.equal(store.data.botArchive?.["222"]?.["42"]?.["5"]?.sessionId, "s-b");
  assert.equal(store.data.botArchive?.["111"], undefined);
});

test("resumeHere continues a past session in the same chat; the old one stays resumable", async () => {
  const { threads, sessions, topics, factory, api } = setup();
  sessions.infos.set("cli-1", { sessionId: "cli-1", summary: "CLI work", lastModified: 1, cwd: api });
  const tab = threads.bindTab(CHAT, 100);
  await threads.send(tab.key, "hello", "hello");
  const p1 = factory.last();
  await p1.emit({ type: "system", subtype: "init", session_id: tab.record.sessionId, model: "m" });
  await p1.finishTurn();
  const before = threads.get(tab.key)!.sessionId;

  const res = await threads.resumeHere(tab.key, "cli-1");
  assert.equal(res.key, tab.key, "same chat, no new topic");
  assert.equal(topics.created.length, 0);
  const r = threads.get(tab.key)!;
  assert.equal(r.sessionId, "cli-1");
  assert.equal(r.started, true);
  assert.equal(r.cwd, api);
  assert.equal(r.title, "CLI work");
  assert.equal(topics.renamed.at(-1)!.name, "CLI work", "auto-titled chats take the session's title");
  assert.equal(threads.findBySession(before), undefined, "the previous session is free for /resume again");

  await threads.send(tab.key, "continue");
  const p2 = factory.last();
  assert.notEqual(p2, p1, "the old process was closed");
  assert.equal(p2.spec.sessionId, "cli-1");
  assert.equal(p2.spec.resume, true);
  assert.equal((await threads.resumeHere(tab.key, "cli-1")).already, true);
});

test("resumeHere: a fresh chat binds to it; a session open elsewhere stays there; a busy chat refuses", async () => {
  const { threads, sessions, factory, web } = setup();
  sessions.infos.set("cli-1", { sessionId: "cli-1", summary: "CLI work", lastModified: 1, cwd: web });
  const fresh = await threads.resumeHere(`${CHAT}:300`, "cli-1");
  assert.equal(threads.get(`${CHAT}:300`)!.sessionId, "cli-1");
  assert.equal(fresh.record.project, "home");
  const other = await threads.resumeHere(`${CHAT}:301`, "cli-1");
  assert.equal(other.elsewhere, true);
  assert.equal(other.key, `${CHAT}:300`);
  assert.equal(threads.get(`${CHAT}:301`), undefined);

  sessions.infos.set("cli-2", { sessionId: "cli-2", summary: "Other", lastModified: 2, cwd: web });
  const busy = threads.bindTab(CHAT, 302);
  await threads.send(busy.key, "long task");
  assert.ok(factory.last());
  await assert.rejects(threads.resumeHere(busy.key, "cli-2"), UserError);
  await assert.rejects(threads.resumeHere(`${CHAT}:303`, "missing"), UserError);
});
