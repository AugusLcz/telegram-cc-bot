import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export type { PermissionMode };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "auto",
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

/** Where a Telegram message goes: a chat (topic, threadId) or, without Threaded Mode, the bot's root (no threadId). */
export interface Target {
  chatId: number;
  threadId?: number;
}

/** Stable identifier of a tab: `${chatId}:${threadId}`. */
export type ThreadKey = string;

export function threadKey(chatId: number, threadId: number): ThreadKey {
  return `${chatId}:${threadId}`;
}

export function parseThreadKey(key: ThreadKey): { chatId: number; threadId: number } {
  const [chatId, threadId] = key.split(":").map(Number);
  return { chatId, threadId };
}

export function targetOfKey(key: ThreadKey): Target {
  return parseThreadKey(key);
}

export interface ProjectRecord {
  name: string;
  path: string;
  addedAt: number;
}

/** Settings that shape a Claude Code process; persisted so a resume restores them. */
export interface SessionSettings {
  model?: string;
  permissionMode: PermissionMode;
  effort?: Effort;
  /** Show Claude's notes between steps and its thinking, not just its answers (/thinking). */
  thinking: boolean;
}

export type TitleSource = "placeholder" | "auto" | "user";

export interface ThreadRecord extends SessionSettings {
  threadId: number;
  /** Current Claude Code session of the tab. */
  sessionId: string;
  /** A transcript exists: start with `resume` instead of creating the session. */
  started: boolean;
  project: string;
  /** Working directory snapshot taken when the tab was created. */
  cwd: string;
  title: string;
  titleSource: TitleSource;
  createdAt: number;
  lastActiveAt: number;
}

export interface ChatRecord {
  activeProject: string;
  defaults: SessionSettings;
  threads: Record<string, ThreadRecord>;
}

export interface StateData {
  version: 1;
  /** The bot whose chats `chats[*].threads` refer to (absent in states written before it was recorded). */
  botId?: number;
  /** Chat ↔ session bindings of other bots this state served: bot ID → chat ID → thread ID → record. */
  botArchive?: Record<string, Record<string, Record<string, ThreadRecord>>>;
  projects: Record<string, ProjectRecord>;
  chats: Record<string, ChatRecord>;
}

export function emptyState(): StateData {
  return { version: 1, projects: {}, chats: {} };
}
