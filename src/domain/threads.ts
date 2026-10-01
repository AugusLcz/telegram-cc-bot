import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionPool } from "../claude/pool.ts";
import type { ProcessSpec, UserContent } from "../claude/process.ts";
import { sessionTitle, type SessionApi } from "../claude/sessions.ts";
import { silentLogger, type Logger } from "../core/logger.ts";
import { KeyedMutex } from "../core/mutex.ts";
import {
  parseThreadKey,
  threadKey,
  type Effort,
  type PermissionMode,
  type ProjectRecord,
  type Target,
  type ThreadKey,
  type ThreadRecord,
  type TitleSource,
} from "../core/types.ts";
import type { Store } from "../store/store.ts";
import type { ChatService } from "./chats.ts";
import { UserError } from "./errors.ts";
import type { ProjectService } from "./projects.ts";

/** Port to the chat platform's tabs (implemented by telegram/topics.ts). */
export interface TopicGateway {
  create(chatId: number, name: string): Promise<number>;
  rename(target: Target, name: string): Promise<void>;
  remove(target: Target): Promise<void>;
}

export interface ThreadServiceDeps {
  store: Store;
  chats: ChatService;
  projects: ProjectService;
  pool: SessionPool;
  topics: TopicGateway;
  sessions: SessionApi;
  /** Short tab title from a prompt. */
  titleFromPrompt: (text: string) => string;
  log?: Logger;
  newSessionId?: () => string;
}

export interface Tab {
  key: ThreadKey;
  record: ThreadRecord;
}

export interface SendOutcome {
  /** The old transcript was missing, so the tab continues in a fresh session. */
  freshSession?: boolean;
}

export const PLACEHOLDER_TITLE = "New session";

function isMissingTranscript(err: unknown): boolean {
  return err instanceof Error && /no conversation found|session.*not found|ENOENT/i.test(err.message);
}

/**
 * Tabs ↔ sessions ↔ processes. Invariants:
 * - a tab has exactly one current session; a session is bound to at most one tab;
 * - a tab's cwd is fixed at creation;
 * - per-tab settings are persisted before being applied to a live process;
 * - sends and destructive changes for one tab are serialised.
 */
export class ThreadService {
  private readonly d: ThreadServiceDeps;
  private readonly log: Logger;
  private readonly mutex = new KeyedMutex();
  private readonly newSessionId: () => string;

  constructor(deps: ThreadServiceDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.newSessionId = deps.newSessionId ?? randomUUID;
  }

  // ---- queries -----------------------------------------------------------

  get(key: ThreadKey): ThreadRecord | undefined {
    const { chatId, threadId } = parseThreadKey(key);
    return this.d.store.data.chats[String(chatId)]?.threads[String(threadId)];
  }

  require(key: ThreadKey): ThreadRecord {
    const r = this.get(key);
    if (!r) throw new UserError("This tab is not linked to a session.");
    return r;
  }

  /** Tabs of a chat, most recently active first. */
  list(chatId: number): Tab[] {
    const threads = this.d.store.data.chats[String(chatId)]?.threads ?? {};
    return Object.values(threads)
      .map((record) => ({ key: threadKey(chatId, record.threadId), record }))
      .sort((a, b) => b.record.lastActiveAt - a.record.lastActiveAt);
  }

  findBySession(sessionId: string): Tab | undefined {
    for (const [chatId, chat] of Object.entries(this.d.store.data.chats)) {
      for (const record of Object.values(chat.threads)) {
        if (record.sessionId === sessionId) return { key: threadKey(Number(chatId), record.threadId), record };
      }
    }
    return undefined;
  }

  specFor(key: ThreadKey): ProcessSpec {
    const r = this.require(key);
    return {
      sessionId: r.sessionId,
      resume: r.started,
      cwd: r.cwd,
      model: r.model,
      permissionMode: r.permissionMode,
      effort: r.effort,
    };
  }

  // ---- opening tabs ------------------------------------------------------

  /** /new: create a tab in the chat's active project with a fresh session. */
  async createTab(chatId: number, title?: string): Promise<Tab> {
    const project = this.d.projects.activeFor(chatId);
    const name = title?.trim() || PLACEHOLDER_TITLE;
    const threadId = await this.d.topics.create(chatId, name);
    return this.save(chatId, this.newRecord(chatId, threadId, project, name, title?.trim() ? "user" : "placeholder"));
  }

  /**
   * A tab the bot has not seen yet (created with Telegram's "+" button, or
   * lost state): bind it to the active project. Returns `created: false`
   * when the tab was already known.
   */
  bindTab(chatId: number, threadId: number, name?: string, implicitName = false): Tab & { created: boolean } {
    const key = threadKey(chatId, threadId);
    const existing = this.get(key);
    if (existing) return { key, record: existing, created: false };
    const project = this.d.projects.activeFor(chatId);
    const source: TitleSource = name && !implicitName ? "user" : "placeholder";
    const tab = this.save(chatId, this.newRecord(chatId, threadId, project, name || PLACEHOLDER_TITLE, source));
    return { ...tab, created: true };
  }

  /** /resume: open an existing session in a new tab (or return the tab that already has it). */
  async resumeIntoTab(chatId: number, sessionId: string): Promise<Tab & { existed: boolean }> {
    const bound = this.findBySession(sessionId);
    if (bound) return { ...bound, existed: true };
    const info = await this.d.sessions.info(sessionId);
    if (!info) throw new UserError(`Session ${sessionId} not found.`);
    const active = this.d.projects.activeFor(chatId);
    const cwd = info.cwd ?? active.path;
    const project = this.d.projects.findByPath(cwd);
    const title = sessionTitle(info);
    const threadId = await this.d.topics.create(chatId, title);
    const record = this.newRecord(chatId, threadId, project ?? { name: "-", path: cwd, addedAt: 0 }, title, "auto");
    record.sessionId = info.sessionId;
    record.started = true;
    record.cwd = cwd;
    return { ...this.save(chatId, record), existed: false };
  }

  /** /fork: copy this tab's transcript into a new session in a new tab. */
  async forkTab(key: ThreadKey): Promise<Tab> {
    const src = this.require(key);
    if (!src.started) throw new UserError("Nothing to fork yet: send a message first.");
    const { chatId } = parseThreadKey(key);
    const sessionId = await this.d.sessions.fork(src.sessionId, src.cwd);
    const title = `${src.title} (fork)`;
    const threadId = await this.d.topics.create(chatId, title);
    const record: ThreadRecord = {
      ...src,
      threadId,
      sessionId,
      started: true,
      title,
      titleSource: "auto",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    return this.save(chatId, record);
  }

  // ---- talking -----------------------------------------------------------

  /**
   * Send to the tab's session, starting or resuming its process as needed.
   * Calls for one tab are processed in order. May wait for a free slot.
   */
  send(key: ThreadKey, content: UserContent, promptText?: string): Promise<SendOutcome> {
    return this.mutex.run(key, async () => {
      const record = this.require(key);
      if (promptText && record.titleSource === "placeholder") await this.autoTitle(key, record, promptText);
      this.touch(record);
      try {
        await this.d.pool.send(key, () => this.specFor(key), content);
        return {};
      } catch (err) {
        if (!record.started || !isMissingTranscript(err)) throw err;
        this.log.warn(`transcript of ${record.sessionId} missing; starting a fresh session in ${key}`);
        this.d.store.update(() => {
          record.sessionId = this.newSessionId();
          record.started = false;
        });
        await this.d.pool.send(key, () => this.specFor(key), content);
        return { freshSession: true };
      }
    });
  }

  /** Keep records in sync with what Claude Code reports. */
  observe(key: ThreadKey, msg: SDKMessage): void {
    const record = this.get(key);
    if (!record) return;
    if (msg.type === "system" && msg.subtype === "init") {
      if (!record.started || record.sessionId !== msg.session_id) {
        this.d.store.update(() => {
          record.started = true;
          record.sessionId = msg.session_id;
        });
      }
    } else if (msg.type === "system" && msg.subtype === "status" && msg.permissionMode && msg.permissionMode !== record.permissionMode) {
      // Claude changed mode itself (e.g. leaving plan mode): resume in the same mode.
      this.d.store.update(() => {
        record.permissionMode = msg.permissionMode!;
      });
    } else if (msg.type === "conversation_reset") {
      this.d.store.update(() => {
        record.sessionId = msg.new_conversation_id;
        record.started = true;
      });
    } else if (msg.type === "result") {
      this.touch(record);
    }
  }

  // ---- settings (persist first, then apply live) --------------------------

  async setModel(key: ThreadKey, model: string | undefined): Promise<void> {
    this.patch(key, { model });
    await this.d.pool.setModel(key, model);
  }

  async setPermissionMode(key: ThreadKey, mode: PermissionMode): Promise<void> {
    this.patch(key, { permissionMode: mode });
    await this.d.pool.setPermissionMode(key, mode);
  }

  async setEffort(key: ThreadKey, effort: Effort | undefined): Promise<void> {
    this.patch(key, { effort });
    await this.d.pool.setEffort(key, effort);
  }

  setVerbose(key: ThreadKey, verbose: boolean): void {
    this.patch(key, { verbose });
  }

  /** /rename: the session and the tab. */
  async rename(key: ThreadKey, title: string): Promise<void> {
    const record = this.require(key);
    this.d.store.update(() => {
      record.title = title;
      record.titleSource = "user";
    });
    await this.d.topics.rename(parseThreadKey(key), title);
    await this.renameSession(record, title);
  }

  /** The user renamed the tab in Telegram: remember it and never auto-rename again. */
  async topicRenamed(key: ThreadKey, title: string): Promise<void> {
    const record = this.get(key);
    if (!record || record.title === title) return;
    this.d.store.update(() => {
      record.title = title;
      record.titleSource = "user";
    });
    await this.renameSession(record, title);
  }

  // ---- lifecycle -----------------------------------------------------------

  /** /close: hibernate now; the next message resumes. */
  async closeTab(key: ThreadKey): Promise<void> {
    this.d.pool.cancelWaiting(key);
    await this.d.pool.hibernate(key, "closed");
  }

  /** /delete: hibernate, delete the tab and forget it. The transcript stays resumable. */
  async deleteTab(key: ThreadKey): Promise<void> {
    this.d.pool.cancelWaiting(key);
    await this.mutex.run(key, async () => {
      await this.d.pool.hibernate(key, "closed");
      try {
        await this.d.topics.remove(parseThreadKey(key));
      } catch (err) {
        this.log.warn(`deleting topic ${key} failed:`, err);
      }
      this.forget(key);
    });
  }

  /** The tab no longer exists: drop its process and record. */
  async topicGone(key: ThreadKey): Promise<ThreadRecord | undefined> {
    const record = this.get(key);
    this.d.pool.cancelWaiting(key);
    await this.d.pool.hibernate(key, "closed");
    this.forget(key);
    return record;
  }

  // ---- internals -------------------------------------------------------------

  private newRecord(chatId: number, threadId: number, project: ProjectRecord, title: string, source: TitleSource): ThreadRecord {
    const defaults = this.d.chats.ensure(chatId).defaults;
    const now = Date.now();
    return {
      threadId,
      sessionId: this.newSessionId(),
      started: false,
      project: project.name,
      cwd: project.path,
      title,
      titleSource: source,
      model: defaults.model,
      permissionMode: defaults.permissionMode,
      effort: defaults.effort,
      verbose: defaults.verbose,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  private save(chatId: number, record: ThreadRecord): Tab {
    const chat = this.d.chats.ensure(chatId);
    this.d.store.update(() => {
      chat.threads[String(record.threadId)] = record;
    });
    return { key: threadKey(chatId, record.threadId), record };
  }

  private forget(key: ThreadKey): void {
    const { chatId, threadId } = parseThreadKey(key);
    this.d.store.update((d) => {
      delete d.chats[String(chatId)]?.threads[String(threadId)];
    });
  }

  private patch(key: ThreadKey, patch: Partial<ThreadRecord>): void {
    const record = this.require(key);
    this.d.store.update(() => {
      Object.assign(record, patch);
      for (const k of Object.keys(patch) as (keyof ThreadRecord)[]) {
        if (patch[k] === undefined) delete record[k];
      }
    });
  }

  private touch(record: ThreadRecord): void {
    this.d.store.update(() => {
      record.lastActiveAt = Date.now();
    });
  }

  private async autoTitle(key: ThreadKey, record: ThreadRecord, promptText: string): Promise<void> {
    const title = this.d.titleFromPrompt(promptText);
    if (!title) return;
    this.d.store.update(() => {
      record.title = title;
      record.titleSource = "auto";
    });
    try {
      await this.d.topics.rename(parseThreadKey(key), title);
    } catch (err) {
      this.log.debug(`auto-title of ${key} failed:`, err);
    }
  }

  private async renameSession(record: ThreadRecord, title: string): Promise<void> {
    if (!record.started) return;
    try {
      await this.d.sessions.rename(record.sessionId, title, record.cwd);
    } catch (err) {
      this.log.debug(`renaming session ${record.sessionId} failed:`, err);
    }
  }
}
