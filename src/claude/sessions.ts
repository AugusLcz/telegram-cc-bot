import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";

export type SessionInfo = SDKSessionInfo;

export interface Recap {
  user?: string;
  assistant?: string;
}

/** One turn of a transcript, as /export shows it. */
export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  tools: { name: string; input: Record<string, unknown> }[];
}

/** Claude Code's on-disk session store, behind an interface so tests can fake it. */
export interface SessionApi {
  list(opts: { dir?: string; limit: number }): Promise<SessionInfo[]>;
  info(sessionId: string): Promise<SessionInfo | undefined>;
  /** Copy a transcript into a new session; returns the new ID. */
  fork(sessionId: string, dir?: string): Promise<string>;
  rename(sessionId: string, title: string, dir?: string): Promise<void>;
  /** Last user prompt and last assistant reply, for a "where were we" note. */
  recap(sessionId: string, dir?: string): Promise<Recap>;
  /** The main thread's messages (no subagents, no tool results). */
  transcript(sessionId: string, dir?: string): Promise<TranscriptEntry[]>;
}

export function sessionTitle(info: SessionInfo): string {
  return (info.customTitle || info.summary || info.firstPrompt || info.sessionId).replace(/\s+/g, " ").trim();
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function toolUses(message: unknown): TranscriptEntry["tools"] {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b?.type === "tool_use" && typeof b.name === "string")
    .map((b) => ({ name: b.name as string, input: (b.input ?? {}) as Record<string, unknown> }));
}

export const sdkSessionApi: SessionApi = {
  list: ({ dir, limit }) => listSessions({ dir, limit }),
  info: (sessionId) => getSessionInfo(sessionId),
  fork: async (sessionId, dir) => (await forkSession(sessionId, { dir })).sessionId,
  rename: (sessionId, title, dir) => renameSession(sessionId, title, { dir }),
  recap: async (sessionId, dir) => {
    const msgs = (await getSessionMessages(sessionId, { dir })).filter((m) => !m.parent_tool_use_id);
    const last = (type: string) =>
      [...msgs].reverse().find((m) => m.type === type && textOf(m.message).trim());
    const user = last("user");
    const assistant = last("assistant");
    return {
      user: user ? textOf(user.message).trim() : undefined,
      assistant: assistant ? textOf(assistant.message).trim() : undefined,
    };
  },
  transcript: async (sessionId, dir) => {
    const msgs = await getSessionMessages(sessionId, { dir });
    return msgs
      .filter((m) => !m.parent_tool_use_id && (m.type === "user" || m.type === "assistant"))
      .map((m) => ({ role: m.type as "user" | "assistant", text: textOf(m.message).trim(), tools: toolUses(m.message) }))
      .filter((e) => e.text || e.tools.length);
  },
};
