import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { silentLogger, type Logger } from "../core/logger.ts";
import type { Effort, PermissionMode } from "../core/types.ts";
import type { ContextUsage, ProcessFactory, ProcessHandle, ProcessSpec, UserContent } from "./process.ts";

/**
 * cold     no process; the session lives only in its transcript
 * starting a process is waiting for a slot or initialising
 * idle     process up, nothing running; may be hibernated
 * busy     turn running, prompt pending or background work alive; never evicted
 */
export type SessionState = "cold" | "starting" | "idle" | "busy";

export type ExitReason = "idle" | "evicted" | "closed" | "crash" | "background-limit" | "shutdown";

export interface PoolPolicy {
  maxLive: number;
  idleMs: number;
  backgroundMaxMs: number;
}

export interface PoolHooks {
  canUseTool(key: string): CanUseTool;
  onMessage(key: string, msg: SDKMessage): Promise<void>;
  /** The key's process is gone (any reason). Not called for starts that failed. */
  onExit(key: string, reason: ExitReason, error?: unknown): void;
  /** A start had to queue because every slot is busy. */
  onWaiting?(key: string, info: { position: number; busy: number }): void;
}

export interface PoolEntryStats {
  key: string;
  state: SessionState;
  lastActive: number;
  blocked: number;
  backgroundTasks: number;
}

export interface PoolStats {
  live: number;
  max: number;
  waiting: number;
  entries: PoolEntryStats[];
}

/** Thrown to callers whose start was cancelled (e.g. /stop while waiting for a slot). */
export class StartCancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "StartCancelledError";
  }
}

interface Entry {
  key: string;
  handle: ProcessHandle | null;
  starting: Promise<ProcessHandle> | null;
  ready: boolean;
  admitted: boolean;
  blocked: number;
  lastActive: number;
  idleTimer: NodeJS.Timeout | null;
  bgTimer: NodeJS.Timeout | null;
}

interface Waiter {
  entry: Entry;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Keeps at most `maxLive` Claude Code processes. Sessions without a process
 * are resumed on demand; idle ones are closed after `idleMs` or evicted (LRU)
 * when another session needs the slot. Keys are opaque strings.
 */
export class SessionPool {
  private readonly factory: ProcessFactory;
  private readonly policy: PoolPolicy;
  private readonly hooks: PoolHooks;
  private readonly log: Logger;
  private readonly entries = new Map<string, Entry>();
  private waiters: Waiter[] = [];

  constructor(factory: ProcessFactory, policy: PoolPolicy, hooks: PoolHooks, log: Logger = silentLogger) {
    this.factory = factory;
    this.policy = policy;
    this.hooks = hooks;
    this.log = log;
  }

  state(key: string): SessionState {
    const e = this.entries.get(key);
    if (!e) return "cold";
    if (!e.ready) return "starting";
    return this.isBusy(e) ? "busy" : "idle";
  }

  /** The live process for `key`, if it is up. */
  get(key: string): ProcessHandle | undefined {
    const e = this.entries.get(key);
    return e?.ready ? e.handle ?? undefined : undefined;
  }

  /** Return the key's process, starting (or resuming) it from `spec()` if needed. */
  ensure(key: string, spec: () => ProcessSpec): Promise<ProcessHandle> {
    const e = this.entries.get(key);
    if (e?.ready && e.handle) return Promise.resolve(e.handle);
    if (e?.starting) return e.starting;
    return this.start(key, spec);
  }

  async send(key: string, spec: () => ProcessSpec, content: UserContent): Promise<void> {
    const handle = await this.ensure(key, spec);
    handle.send(content);
    const e = this.entries.get(key);
    if (e) {
      e.lastActive = Date.now();
      this.refresh(e);
    }
  }

  /** Pending prompts keep a session busy so it is never evicted under the user. */
  setBlocked(key: string, delta: number): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.blocked = Math.max(0, e.blocked + delta);
    this.refresh(e);
  }

  /** Interrupt the running turn. Returns false when nothing was running. */
  async interrupt(key: string): Promise<boolean> {
    const h = this.get(key);
    if (!h?.turnActive) return false;
    await h.interrupt();
    return true;
  }

  /** Abort a start that is still waiting for a slot. */
  cancelWaiting(key: string): boolean {
    const w = this.waiters.find((x) => x.entry.key === key);
    if (!w) return false;
    this.waiters = this.waiters.filter((x) => x !== w);
    if (this.entries.get(key) === w.entry) this.entries.delete(key);
    w.reject(new StartCancelledError());
    return true;
  }

  async setModel(key: string, model: string | undefined): Promise<void> {
    await this.get(key)?.setModel(model);
  }

  async setPermissionMode(key: string, mode: PermissionMode): Promise<void> {
    await this.get(key)?.setPermissionMode(mode);
  }

  async setEffort(key: string, effort: Effort | undefined): Promise<void> {
    await this.get(key)?.setEffort(effort);
  }

  async setShowThinking(key: string, on: boolean): Promise<void> {
    await this.get(key)?.setShowThinking(on);
  }

  /** A title from the key's live process (null without one). */
  async generateTitle(key: string, description: string, opts?: { persist?: boolean }): Promise<string | null> {
    return (await this.get(key)?.generateTitle(description, opts)) ?? null;
  }

  async contextUsage(key: string): Promise<ContextUsage | null> {
    return (await this.get(key)?.contextUsage()) ?? null;
  }

  /** Close the key's process now (the session stays resumable). */
  async hibernate(key: string, reason: ExitReason = "closed"): Promise<void> {
    const e = this.entries.get(key);
    if (e) await this.evict(e, reason);
  }

  async shutdown(): Promise<void> {
    for (const w of this.waiters.splice(0)) w.reject(new StartCancelledError("shutting down"));
    await Promise.all([...this.entries.values()].map((e) => this.evict(e, "shutdown")));
  }

  stats(): PoolStats {
    return {
      live: this.admittedCount(),
      max: this.policy.maxLive,
      waiting: this.waiters.length,
      entries: [...this.entries.values()].map((e) => ({
        key: e.key,
        state: this.state(e.key),
        lastActive: e.lastActive,
        blocked: e.blocked,
        backgroundTasks: e.handle?.backgroundTasks ?? 0,
      })),
    };
  }

  // ---- internals ---------------------------------------------------------

  private start(key: string, spec: () => ProcessSpec): Promise<ProcessHandle> {
    const entry: Entry = {
      key,
      handle: null,
      starting: null,
      ready: false,
      admitted: false,
      blocked: 0,
      lastActive: Date.now(),
      idleTimer: null,
      bgTimer: null,
    };
    this.entries.set(key, entry);
    // The admission decision happens synchronously inside this call, before any await.
    const admitted = this.admit(entry);
    entry.starting = (async () => {
      try {
        await admitted;
        const handle = this.factory.create(spec(), {
          canUseTool: this.hooks.canUseTool(key),
          onMessage: async (msg) => {
            entry.lastActive = Date.now();
            await this.hooks.onMessage(key, msg);
            this.refresh(entry);
          },
          onExit: (error) => this.onProcessExit(entry, error),
        });
        entry.handle = handle;
        await handle.start();
        if (this.entries.get(key) !== entry) {
          // Hibernated or shut down while starting.
          await handle.close().catch(() => {});
          throw new StartCancelledError();
        }
        entry.ready = true;
        entry.starting = null;
        this.log.debug(`started ${key}`);
        this.refresh(entry);
        return handle;
      } catch (err) {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
          this.clearTimers(entry);
          this.drainWaiters();
        }
        throw err;
      }
    })();
    return entry.starting;
  }

  private admittedCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.admitted) n++;
    return n;
  }

  private isBusy(e: Entry): boolean {
    const h = e.handle;
    return !!h && (h.turnActive || e.blocked > 0 || h.backgroundTasks > 0);
  }

  private lruIdle(): Entry | undefined {
    let victim: Entry | undefined;
    for (const e of this.entries.values()) {
      if (!e.ready || this.isBusy(e)) continue;
      if (!victim || e.lastActive < victim.lastActive) victim = e;
    }
    return victim;
  }

  private tryAdmit(entry: Entry): boolean {
    if (this.admittedCount() < this.policy.maxLive) {
      entry.admitted = true;
      return true;
    }
    const victim = this.lruIdle();
    if (!victim) return false;
    entry.admitted = true;
    this.log.debug(`evicting ${victim.key} for ${entry.key}`);
    void this.evict(victim, "evicted");
    return true;
  }

  private admit(entry: Entry): Promise<void> {
    if (this.tryAdmit(entry)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ entry, resolve, reject });
      this.hooks.onWaiting?.(entry.key, { position: this.waiters.length, busy: this.admittedCount() });
    });
  }

  /** Hand free (or freeable) slots to waiting starts, oldest first. */
  private drainWaiters(): void {
    while (this.waiters.length && this.tryAdmit(this.waiters[0].entry)) {
      this.waiters.shift()!.resolve();
    }
  }

  /** Re-evaluate timers after anything that can change busy/idle. */
  private refresh(e: Entry): void {
    if (!e.ready || this.entries.get(e.key) !== e) return;
    const h = e.handle!;
    if (h.turnActive || e.blocked > 0) {
      this.clearTimers(e);
      return;
    }
    if (h.backgroundTasks > 0) {
      if (e.idleTimer) clearTimeout(e.idleTimer);
      e.idleTimer = null;
      e.bgTimer ??= setTimeout(() => void this.expire(e, "background-limit"), this.policy.backgroundMaxMs).unref();
      return;
    }
    this.clearTimers(e);
    e.idleTimer = setTimeout(() => void this.expire(e, "idle"), this.policy.idleMs).unref();
    this.drainWaiters();
  }

  private async expire(e: Entry, reason: ExitReason): Promise<void> {
    if (this.entries.get(e.key) !== e) return;
    const h = e.handle;
    if (reason === "idle" && h && (h.turnActive || e.blocked > 0 || h.backgroundTasks > 0)) return;
    if (reason === "background-limit" && h && (h.turnActive || e.blocked > 0)) return;
    await this.evict(e, reason);
  }

  private clearTimers(e: Entry): void {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    if (e.bgTimer) clearTimeout(e.bgTimer);
    e.idleTimer = null;
    e.bgTimer = null;
  }

  private async evict(e: Entry, reason: ExitReason): Promise<void> {
    if (this.entries.get(e.key) !== e) return;
    this.entries.delete(e.key);
    this.clearTimers(e);
    const waiting = this.waiters.find((w) => w.entry === e);
    if (waiting) {
      this.waiters = this.waiters.filter((w) => w !== waiting);
      waiting.reject(new StartCancelledError());
    }
    this.drainWaiters();
    if (e.handle) {
      try {
        await e.handle.close();
      } catch (err) {
        this.log.warn(`closing ${e.key} failed:`, err);
      }
    }
    if (e.ready) {
      this.log.debug(`hibernated ${e.key} (${reason})`);
      this.hooks.onExit(e.key, reason);
    }
  }

  private onProcessExit(e: Entry, error: unknown): void {
    if (this.entries.get(e.key) !== e) return;
    this.entries.delete(e.key);
    this.clearTimers(e);
    this.drainWaiters();
    if (e.ready) {
      this.log.warn(`process for ${e.key} exited unexpectedly:`, error);
      this.hooks.onExit(e.key, "crash", error);
    }
  }
}
