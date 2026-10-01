import {
  query,
  type CanUseTool,
  type ModelInfo,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { silentLogger, type Logger } from "../core/logger.ts";
import { AsyncQueue } from "../core/queue.ts";
import type { Effort, PermissionMode } from "../core/types.ts";

export type UserContent = SDKUserMessage["message"]["content"];
export type ContextUsage = SDKControlGetContextUsageResponse;

/** Everything needed to (re)start the process serving one session. */
export interface ProcessSpec {
  sessionId: string;
  /** true: the transcript exists, resume it. false: create the session with this ID. */
  resume: boolean;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  effort?: Effort;
}

export interface ProcessHooks {
  canUseTool: CanUseTool;
  /** Every SDK message in order; awaited before the next one is delivered. */
  onMessage(msg: SDKMessage): Promise<void>;
  /** The process ended without close() being called. */
  onExit(error?: unknown): void;
}

/** A running Claude Code process serving exactly one session. */
export interface ProcessHandle {
  /** Current session ID; follows conversation resets (/clear). */
  readonly sessionId: string;
  /** A turn is running: from send() until its result. */
  readonly turnActive: boolean;
  /** Live non-ambient background tasks (shells, subagents, monitors). */
  readonly backgroundTasks: number;
  readonly commands: SlashCommand[];
  readonly models: ModelInfo[];
  start(): Promise<void>;
  send(content: UserContent): void;
  interrupt(): Promise<void>;
  setModel(model: string | undefined): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setEffort(effort: Effort | undefined): Promise<void>;
  contextUsage(): Promise<ContextUsage | null>;
  close(): Promise<void>;
}

export interface ProcessFactory {
  create(spec: ProcessSpec, hooks: ProcessHooks): ProcessHandle;
}

export interface SdkProcessOptions {
  claudePath?: string;
  initTimeoutMs?: number;
  log?: Logger;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

/** ProcessHandle backed by one Agent SDK query() in streaming-input mode. */
export class SdkProcess implements ProcessHandle {
  sessionId: string;
  turnActive = false;
  backgroundTasks = 0;
  commands: SlashCommand[] = [];
  models: ModelInfo[] = [];

  private readonly spec: ProcessSpec;
  private readonly hooks: ProcessHooks;
  private readonly opts: SdkProcessOptions;
  private readonly log: Logger;
  private q: Query | null = null;
  private input: AsyncQueue<SDKUserMessage> | null = null;
  private loop: Promise<void> | null = null;
  private closing = false;

  constructor(spec: ProcessSpec, hooks: ProcessHooks, opts: SdkProcessOptions = {}) {
    this.spec = spec;
    this.hooks = hooks;
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    this.sessionId = spec.sessionId;
  }

  async start(): Promise<void> {
    if (this.q) return;
    const s = this.spec;
    const input = new AsyncQueue<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        cwd: s.cwd,
        model: s.model,
        permissionMode: s.permissionMode,
        allowDangerouslySkipPermissions: true,
        effort: s.effort,
        ...(s.resume ? { resume: s.sessionId } : { sessionId: s.sessionId }),
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        canUseTool: this.hooks.canUseTool,
        pathToClaudeCodeExecutable: this.opts.claudePath,
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
        stderr: (data) => this.log.debug(`[claude] ${data.trimEnd()}`),
      },
    });
    this.q = q;
    this.input = input;
    this.loop = this.consume(q);
    try {
      const init = await withTimeout(q.initializationResult(), this.opts.initTimeoutMs ?? 60_000, "Claude Code start");
      this.commands = init.commands;
      this.models = init.models;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  private async consume(q: Query): Promise<void> {
    let failure: unknown;
    try {
      for await (const msg of q) {
        this.observe(msg);
        try {
          await this.hooks.onMessage(msg);
        } catch (err) {
          this.log.error("message handler failed:", err);
        }
      }
    } catch (err) {
      failure = err;
    } finally {
      const unexpected = !this.closing;
      this.q = null;
      this.input?.close();
      this.input = null;
      this.turnActive = false;
      this.backgroundTasks = 0;
      if (unexpected) this.hooks.onExit(failure ?? new Error("Claude Code exited"));
    }
  }

  private observe(msg: SDKMessage): void {
    if (msg.type === "system") {
      if (msg.subtype === "init") {
        this.turnActive = true; // emitted at the start of every turn, including queued ones
        this.sessionId = msg.session_id;
      } else if (msg.subtype === "commands_changed") {
        this.commands = msg.commands;
      } else if (msg.subtype === "background_tasks_changed") {
        this.backgroundTasks = msg.tasks.filter((t) => !t.ambient).length;
      }
    } else if (msg.type === "conversation_reset") {
      this.sessionId = msg.new_conversation_id;
    } else if (msg.type === "result") {
      this.turnActive = false;
    }
  }

  send(content: UserContent): void {
    if (!this.input) throw new Error("Claude Code process is not running");
    this.turnActive = true;
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.q?.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q?.setPermissionMode(mode);
  }

  async setEffort(effort: Effort | undefined): Promise<void> {
    await this.q?.applyFlagSettings({ effortLevel: effort ?? null });
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return this.q ? this.q.getContextUsage() : null;
  }

  async close(): Promise<void> {
    this.closing = true;
    const q = this.q;
    const loop = this.loop;
    this.input?.close();
    if (q) {
      q.close();
      await Promise.race([loop, new Promise((r) => setTimeout(r, 3000))]);
    }
  }
}

export class SdkProcessFactory implements ProcessFactory {
  private readonly opts: SdkProcessOptions;
  constructor(opts: SdkProcessOptions = {}) {
    this.opts = opts;
  }
  create(spec: ProcessSpec, hooks: ProcessHooks): ProcessHandle {
    return new SdkProcess(spec, hooks, this.opts);
  }
}
