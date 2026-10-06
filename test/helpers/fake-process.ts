import type { AgentInfo, McpServerStatus, ModelInfo, SDKMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import {
  trackTasks,
  type ContextUsage,
  type ProcessFactory,
  type ProcessHandle,
  type ProcessHooks,
  type ProcessSpec,
  type TaskInfo,
  type UserContent,
} from "../../src/claude/process.ts";
import type { Effort, PermissionMode } from "../../src/core/types.ts";

/** Scriptable stand-in for a Claude Code process. */
export class FakeProcess implements ProcessHandle {
  sessionId: string;
  turnActive = false;
  tasks: TaskInfo[] = [];
  commands: SlashCommand[] = [{ name: "compact", description: "Compact", argumentHint: "", builtin: true }];
  agents: AgentInfo[] = [];
  mcp: McpServerStatus[] = [];
  /** Control calls in order, e.g. "toggle:github:false". */
  controls: string[] = [];
  models: ModelInfo[] = [{ value: "sonnet", displayName: "Sonnet", description: "Sonnet model" }];
  started = false;
  closed = false;
  sent: UserContent[] = [];
  model: string | undefined;
  permissionMode: PermissionMode;
  effort: Effort | undefined;
  showThinking: boolean;
  /** What generateTitle answers; the descriptions it was asked for are kept. */
  title: string | null = null;
  titleRequests: { description: string; persist: boolean }[] = [];
  interrupts = 0;
  readonly spec: ProcessSpec;
  readonly hooks: ProcessHooks;
  private readonly factory: FakeFactory;

  constructor(spec: ProcessSpec, hooks: ProcessHooks, factory: FakeFactory) {
    this.spec = spec;
    this.hooks = hooks;
    this.factory = factory;
    this.sessionId = spec.sessionId;
    this.model = spec.model;
    this.permissionMode = spec.permissionMode;
    this.effort = spec.effort;
    this.showThinking = spec.showThinking ?? false;
  }

  async start(): Promise<void> {
    if (this.factory.startDelayMs) await new Promise((r) => setTimeout(r, this.factory.startDelayMs));
    if (this.factory.failNextStart) {
      const err = this.factory.failNextStart;
      this.factory.failNextStart = null;
      throw err;
    }
    this.started = true;
  }

  send(content: UserContent): void {
    if (!this.started || this.closed) throw new Error("not running");
    this.turnActive = true;
    this.sent.push(content);
    this.factory.onSend?.(this, content);
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
    await this.finishTurn();
  }

  async setModel(model: string | undefined): Promise<void> {
    this.model = model;
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
  }
  async setEffort(effort: Effort | undefined): Promise<void> {
    this.effort = effort;
  }
  async setShowThinking(on: boolean): Promise<void> {
    this.showThinking = on;
    this.controls.push(`thinking:${on ? "on" : "off"}`);
  }
  async generateTitle(description: string, opts: { persist?: boolean } = {}): Promise<string | null> {
    this.titleRequests.push({ description, persist: opts.persist === true });
    return this.title;
  }
  async contextUsage(): Promise<ContextUsage | null> {
    return { percentage: 12, totalTokens: 24000, maxTokens: 200000 } as ContextUsage;
  }
  get backgroundTasks(): number {
    return this.tasks.length;
  }
  async supportedCommands(): Promise<SlashCommand[]> {
    return this.commands;
  }
  async supportedAgents(): Promise<AgentInfo[]> {
    return this.agents;
  }
  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.mcp;
  }
  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    this.controls.push(`toggle:${name}:${enabled}`);
    const s = this.mcp.find((m) => m.name === name);
    if (s) s.status = enabled ? "connected" : "disabled";
  }
  async reconnectMcpServer(name: string): Promise<void> {
    this.controls.push(`reconnect:${name}`);
  }
  async reloadPlugins(): Promise<void> {
    this.controls.push("reloadPlugins");
  }
  async stopTask(id: string): Promise<void> {
    this.controls.push(`stopTask:${id}`);
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  // ---- test controls -------------------------------------------------------

  /** Deliver an SDK message the way SdkProcess does (state first, then hooks). */
  async emit(msg: Record<string, unknown>): Promise<void> {
    const m = msg as {
      type: string;
      subtype?: string;
      tasks?: { task_id: string; task_type: string; description: string; ambient?: boolean }[];
      new_conversation_id?: string;
    };
    if (m.type === "system" && m.subtype === "init") this.turnActive = true;
    if (m.type === "system" && m.subtype === "background_tasks_changed") this.tasks = trackTasks(this.tasks, m.tasks ?? []);
    if (m.type === "conversation_reset" && m.new_conversation_id) this.sessionId = m.new_conversation_id;
    if (m.type === "result") this.turnActive = false;
    await this.hooks.onMessage({ session_id: this.sessionId, uuid: "u", ...msg } as unknown as SDKMessage);
  }

  async finishTurn(text = "done"): Promise<void> {
    await this.emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
    await this.emit({ type: "result", subtype: "success", is_error: false, result: text, duration_ms: 5, num_turns: 1 });
  }

  crash(error: Error = new Error("boom")): void {
    this.closed = true;
    this.turnActive = false;
    this.hooks.onExit(error);
  }
}

export class FakeFactory implements ProcessFactory {
  created: FakeProcess[] = [];
  startDelayMs = 0;
  failNextStart: Error | null = null;
  onSend?: (p: FakeProcess, content: UserContent) => void;
  /** Script a process (commands, agents, MCP servers…) as soon as it is created. */
  onCreate?: (p: FakeProcess) => void;

  create(spec: ProcessSpec, hooks: ProcessHooks): ProcessHandle {
    const p = new FakeProcess(spec, hooks, this);
    this.created.push(p);
    this.onCreate?.(p);
    return p;
  }

  last(): FakeProcess {
    return this.created[this.created.length - 1];
  }

  live(): FakeProcess[] {
    return this.created.filter((p) => p.started && !p.closed);
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Poll until `predicate` holds (or fail after `timeoutMs`). */
export async function waitFor(predicate: () => boolean, timeoutMs = 1000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}
