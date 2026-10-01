import os from "node:os";
import path from "node:path";
import { EFFORTS, PERMISSION_MODES, type Effort, type PermissionMode } from "./types.ts";
import type { LogLevel } from "./logger.ts";

export type StreamMode = "draft" | "edit" | "off";

export interface Config {
  botToken: string;
  allowedUserIds: Set<number>;
  defaultCwd: string;
  allowedRoots: string[];
  defaultModel: string | undefined;
  defaultPermissionMode: PermissionMode;
  defaultEffort: Effort | undefined;
  claudePath: string | undefined;
  stateFile: string;
  streamMode: StreamMode;
  permissionTimeoutMs: number;
  maxLiveSessions: number;
  sessionIdleMs: number;
  backgroundMaxMs: number;
  logLevel: LogLevel;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
  return n;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T): T;
function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: undefined): T | undefined;
function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T | undefined): T | undefined {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!allowed.includes(raw as T)) throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  return raw as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const allowedUserIds = new Set(list(env.ALLOWED_USER_IDS).map(Number).filter(Number.isSafeInteger));
  if (allowedUserIds.size === 0) {
    throw new Error("ALLOWED_USER_IDS is required (comma-separated Telegram user IDs)");
  }

  return {
    botToken,
    allowedUserIds,
    defaultCwd: path.resolve(env.DEFAULT_CWD?.trim() || os.homedir()),
    allowedRoots: list(env.ALLOWED_ROOTS).map((p) => path.resolve(p)),
    defaultModel: env.DEFAULT_MODEL?.trim() || undefined,
    defaultPermissionMode: oneOf(env, "DEFAULT_PERMISSION_MODE", PERMISSION_MODES, "auto"),
    defaultEffort: oneOf(env, "DEFAULT_EFFORT", EFFORTS, undefined),
    claudePath: env.CLAUDE_PATH?.trim() || undefined,
    stateFile: path.resolve(env.STATE_FILE?.trim() || "./data/state.json"),
    streamMode: oneOf(env, "STREAM_MODE", ["draft", "edit", "off"] as const, "draft"),
    permissionTimeoutMs: positiveNumber(env, "PERMISSION_TIMEOUT_MS", 10 * 60_000),
    maxLiveSessions: Math.floor(positiveNumber(env, "MAX_LIVE_SESSIONS", 3)),
    sessionIdleMs: positiveNumber(env, "SESSION_IDLE_MINUTES", 15) * 60_000,
    backgroundMaxMs: positiveNumber(env, "BACKGROUND_MAX_MINUTES", 120) * 60_000,
    logLevel: oneOf(env, "LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  };
}

/** True when `dir` is inside one of `roots` (or no roots are configured). */
export function isAllowedDir(dir: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  const target = path.resolve(dir);
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}
