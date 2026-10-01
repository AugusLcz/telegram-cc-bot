import fs from "node:fs";
import path from "node:path";
import { silentLogger, type Logger } from "../core/logger.ts";
import { emptyState, type StateData } from "../core/types.ts";

/**
 * Persistent bot state. Reads are synchronous against an in-memory copy;
 * `update` mutates it and schedules a write. Implementations decide how and
 * when the data reaches disk.
 */
export interface Store {
  readonly data: Readonly<StateData>;
  update(mutate: (data: StateData) => void): void;
  /** Write pending changes now. */
  flush(): Promise<void>;
}

/** In-memory store for tests. */
export class MemoryStore implements Store {
  data: StateData;
  constructor(initial: StateData = emptyState()) {
    this.data = initial;
  }
  update(mutate: (data: StateData) => void): void {
    mutate(this.data);
  }
  async flush(): Promise<void> {}
}

/**
 * JSON file store. Writes are debounced, serialised and atomic (temp file +
 * rename), so a crash never leaves a half-written file. A corrupt file is
 * moved aside instead of blocking startup.
 */
export class JsonFileStore implements Store {
  data: StateData;
  private readonly file: string;
  private readonly debounceMs: number;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(file: string, opts: { debounceMs?: number; log?: Logger } = {}) {
    this.file = file;
    this.debounceMs = opts.debounceMs ?? 250;
    this.log = opts.log ?? silentLogger;
    this.data = this.load();
  }

  private load(): StateData {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StateData>;
      if (parsed.version !== 1) throw new Error(`unsupported state version ${String(parsed.version)}`);
      return { ...emptyState(), ...parsed, version: 1 };
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, aside);
      this.log.warn(`state file unreadable, moved to ${aside}; starting empty:`, err);
      return emptyState();
    }
  }

  update(mutate: (data: StateData) => void): void {
    mutate(this.data);
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch((err) => this.log.error("state write failed:", err));
      }, this.debounceMs);
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A failed write must not wedge the chain: later flushes still run.
    const run = this.writing
      .catch(() => {})
      .then(() => {
        if (!this.dirty) return;
        this.dirty = false;
        try {
          const json = JSON.stringify(this.data, null, 2);
          fs.mkdirSync(path.dirname(this.file), { recursive: true });
          const tmp = `${this.file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, json, { mode: 0o600 });
          fs.renameSync(tmp, this.file);
        } catch (err) {
          this.dirty = true;
          throw err;
        }
      });
    this.writing = run;
    return run;
  }
}
