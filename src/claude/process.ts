import {
  query,
  type AgentInfo,
  type CanUseTool,
  type McpServerStatus,
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

/** A live background task of a session (a shell, a subagent, a monitor…). */
export interface TaskInfo {
  id: string;
  type: string;
  description: string;
  /** When this process first reported it. */
  since: number;
}

/** A running Claude Code process serving exactly one session. */
export interface ProcessHandle {
  /** Current session ID; follows conversation resets (/clear). */
  readonly sessionId: string;
  /** A turn is running: from send() until its result. */
  readonly turnActive: boolean;
  /** Live non-ambient background tasks (shells, subagents, monitors). */
  readonly backgroundTasks: number;
  readonly tasks: readonly TaskInfo[];
  readonly commands: SlashCommand[];
  readonly models: ModelInfo[];
  start(): Promise<void>;
  send(content: UserContent): void;
  interrupt(): Promise<void>;
  setModel(model: string | undefined): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setEffort(effort: Effort | undefined): Promise<void>;
  contextUsage(): Promise<ContextUsage | null>;
  /** Slash commands and skills as Claude Code sees them now (asked afresh). */
  supportedCommands(): Promise<SlashCommand[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
  reconnectMcpServer(name: string): Promise<void>;
  /** Load plugin changes made on disk (install, enable…) into this session. */
  reloadPlugins(): Promise<void>;
  stopTask(id: string): Promise<void>;
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

/** Bot settings that must never reach Claude Code, nor the tools and MCP servers it runs. */
const BOT_ONLY_ENV = ["TELEGRAM_BOT_TOKEN"];

/**
 * Environment for Claude Code processes: the bot's own minus its secrets. A
 * session that saw TELEGRAM_BOT_TOKEN could leak it, or start a second poller
 * on the same bot (anything reading that variable, e.g. this bot's own code).
 */
export function claudeEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: "tg-cc-bot" };
  for (const key of BOT_ONLY_ENV) delete env[key];
  return env;
}

/**
 * Settings applied on top of the account's own in every session the bot starts.
 * Claude Code's Telegram channel plugin starts a poller in each session that
 * loads it; on this bot's token that is a second client stealing its messages
 * (409 Conflict), one more for every open chat. The bot is the Telegram side here.
 */
export const SESSION_FLAG_SETTINGS = {
  enabledPlugins: { "telegram@claude-plugins-official": false },
};

/**
 * The live, non-ambient tasks of a background_tasks_changed snapshot, keeping
 * when each was first seen.
 */
export function trackTasks(
  previous: readonly TaskInfo[],
  snapshot: readonly { task_id: string; task_type: string; description: string; ambient?: boolean }[],
  now = Date.now(),
): TaskInfo[] {
  const since = new Map(previous.map((t) => [t.id, t.since]));
  return snapshot
    .filter((t) => !t.ambient)
    .map((t) => ({ id: t.task_id, type: t.task_type, description: t.description, since: since.get(t.task_id) ?? now }));
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
  tasks: TaskInfo[] = [];
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
        // Claude Code's own system prompt. Left out, the SDK sends an empty one.
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        settings: SESSION_FLAG_SETTINGS,
        canUseTool: this.hooks.canUseTool,
        env: claudeEnv(),
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
      this.tasks = [];
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
        this.tasks = trackTasks(this.tasks, msg.tasks);
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

  get backgroundTasks(): number {
    return this.tasks.length;
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return this.q ? this.q.getContextUsage() : null;
  }

  private running(): Query {
    if (!this.q) throw new Error("Claude Code process is not running");
    return this.q;
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    this.commands = await this.running().supportedCommands();
    return this.commands;
  }

  supportedAgents(): Promise<AgentInfo[]> {
    return this.running().supportedAgents();
  }

  mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.running().mcpServerStatus();
  }

  toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    return this.running().toggleMcpServer(name, enabled);
  }

  reconnectMcpServer(name: string): Promise<void> {
    return this.running().reconnectMcpServer(name);
  }

  async reloadPlugins(): Promise<void> {
    await this.running().reloadPlugins();
  }

  stopTask(id: string): Promise<void> {
    return this.running().stopTask(id);
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
