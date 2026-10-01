import type { ModelInfo, SDKMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type {
  ContextUsage,
  ProcessFactory,
  ProcessHandle,
  ProcessHooks,
  ProcessSpec,
  UserContent,
} from "../../src/claude/process.ts";
import type { Effort, PermissionMode } from "../../src/core/types.ts";

/** Scriptable stand-in for a Claude Code process. */
export class FakeProcess implements ProcessHandle {
  sessionId: string;
  turnActive = false;
  backgroundTasks = 0;
  commands: SlashCommand[] = [{ name: "compact", description: "Compact", argumentHint: "" }];
  models: ModelInfo[] = [{ value: "sonnet", displayName: "Sonnet", description: "Sonnet model" }];
  started = false;
  closed = false;
  sent: UserContent[] = [];
  model: string | undefined;
  permissionMode: PermissionMode;
  effort: Effort | undefined;
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
  async contextUsage(): Promise<ContextUsage | null> {
    return { percentage: 12, totalTokens: 24000, maxTokens: 200000 } as ContextUsage;
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  // ---- test controls -------------------------------------------------------

  /** Deliver an SDK message the way SdkProcess does (state first, then hooks). */
  async emit(msg: Record<string, unknown>): Promise<void> {
    const m = msg as { type: string; subtype?: string; tasks?: { ambient?: boolean }[]; new_conversation_id?: string };
    if (m.type === "system" && m.subtype === "init") this.turnActive = true;
    if (m.type === "system" && m.subtype === "background_tasks_changed") {
      this.backgroundTasks = (m.tasks ?? []).filter((t) => !t.ambient).length;
    }
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

  create(spec: ProcessSpec, hooks: ProcessHooks): ProcessHandle {
    const p = new FakeProcess(spec, hooks, this);
    this.created.push(p);
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
