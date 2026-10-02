import fs from "node:fs";
import path from "node:path";

/**
 * Claude Code's configuration as files on disk, read for display only
 * (/memory, /permissions, /hooks). Claude Code itself stays the authority on
 * how they combine; these views list what is there and where it comes from.
 */

export interface SettingsSource {
  /** "managed", "user", "project" or "local". */
  scope: string;
  path: string;
  data: Record<string, unknown>;
}

function managedDir(platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The settings files that apply in `cwd`, highest precedence first. Missing or unreadable ones are skipped. */
export function settingsSources(home: string, cwd: string, managed = managedDir()): SettingsSource[] {
  const candidates: [string, string][] = [
    ["managed", path.join(managed, "managed-settings.json")],
    ["local", path.join(cwd, ".claude", "settings.local.json")],
    ["project", path.join(cwd, ".claude", "settings.json")],
    ["user", path.join(home, ".claude", "settings.json")],
  ];
  const out: SettingsSource[] = [];
  for (const [scope, file] of candidates) {
    const data = readJson(file);
    if (data) out.push({ scope, path: file, data });
  }
  return out;
}

export interface PermissionsView {
  source: SettingsSource;
  defaultMode?: string;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function permissionsView(sources: SettingsSource[]): PermissionsView[] {
  return sources
    .map((source) => {
      const p = (source.data.permissions ?? {}) as Record<string, unknown>;
      return {
        source,
        defaultMode: typeof p.defaultMode === "string" ? p.defaultMode : undefined,
        allow: strings(p.allow),
        ask: strings(p.ask),
        deny: strings(p.deny),
        additionalDirectories: strings(p.additionalDirectories),
      };
    })
    .filter((v) => v.defaultMode || v.allow.length || v.ask.length || v.deny.length || v.additionalDirectories.length);
}

export interface HookView {
  source: SettingsSource;
  event: string;
  matcher: string;
  commands: string[];
}

/** settings.hooks: { Event: [{ matcher, hooks: [{ type, command | prompt | url }] }] } */
export function hooksView(sources: SettingsSource[]): HookView[] {
  const out: HookView[] = [];
  for (const source of sources) {
    const hooks = source.data.hooks;
    if (!hooks || typeof hooks !== "object") continue;
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups as Record<string, unknown>[]) {
        const entries = Array.isArray(g?.hooks) ? (g.hooks as Record<string, unknown>[]) : [];
        const commands = entries.map((h) => String(h.command ?? h.prompt ?? h.url ?? h.type ?? "?"));
        out.push({ source, event, matcher: typeof g?.matcher === "string" && g.matcher ? g.matcher : "*", commands });
      }
    }
  }
  return out;
}

export interface InstructionFile {
  /** "managed", "user" or "project". */
  scope: string;
  path: string;
  bytes: number;
}

function fileSize(file: string): number | undefined {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/** The directories from the filesystem root down to `dir`. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(dir);
  for (;;) {
    out.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return out;
    cur = parent;
  }
}

/**
 * The instruction files a session in `cwd` loads at start: managed and user
 * CLAUDE.md, then for every directory from the root down to `cwd` its
 * CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md. A directory without a
 * CLAUDE.md contributes its AGENTS.md instead (Claude Code's default).
 */
export function instructionFiles(home: string, cwd: string, managed = managedDir()): InstructionFile[] {
  const out: InstructionFile[] = [];
  const add = (scope: string, file: string) => {
    const bytes = fileSize(file);
    if (bytes !== undefined) out.push({ scope, path: file, bytes });
    return bytes !== undefined;
  };
  add("managed", path.join(managed, "CLAUDE.md"));
  add("user", path.join(home, ".claude", "CLAUDE.md"));
  for (const dir of ancestors(cwd)) {
    const main = add("project", path.join(dir, "CLAUDE.md"));
    const dotted = add("project", path.join(dir, ".claude", "CLAUDE.md"));
    if (!main && !dotted) add("project", path.join(dir, "AGENTS.md"));
    add("project", path.join(dir, "CLAUDE.local.md"));
  }
  return out;
}
