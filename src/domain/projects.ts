import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAllowedDir } from "../core/config.ts";
import type { ProjectRecord } from "../core/types.ts";
import type { Store } from "../store/store.ts";
import type { ChatService } from "./chats.ts";
import { UserError } from "./errors.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export interface ProjectServiceOptions {
  allowedRoots: string[];
  /** Overridable for tests; defaults to an fs.access W_OK check. */
  isWritable?: (dir: string) => boolean;
}

function defaultWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Named working directories; each chat has an active one used for new tabs. */
export class ProjectService {
  private readonly store: Store;
  private readonly chats: ChatService;
  private readonly opts: ProjectServiceOptions;

  constructor(store: Store, chats: ChatService, opts: ProjectServiceOptions) {
    this.store = store;
    this.chats = chats;
    this.opts = opts;
  }

  list(): ProjectRecord[] {
    return Object.values(this.store.data.projects).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ProjectRecord | undefined {
    return this.store.data.projects[name];
  }

  findByPath(dir: string): ProjectRecord | undefined {
    const target = path.resolve(dir);
    return this.list().find((p) => path.resolve(p.path) === target);
  }

  /** Validate and register a project. */
  add(name: string, rawPath: string): ProjectRecord {
    if (!NAME.test(name)) throw new UserError("Project names use letters, digits, '.', '_' or '-' (max 32 chars).");
    if (this.get(name)) throw new UserError(`Project "${name}" already exists.`);
    const dir = path.resolve(expandHome(rawPath.trim()));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UserError(`Not a directory: ${dir}`);
    if (!isAllowedDir(dir, this.opts.allowedRoots)) {
      throw new UserError(`${dir} is outside ALLOWED_ROOTS (${this.opts.allowedRoots.join(", ")}).`);
    }
    if (!(this.opts.isWritable ?? defaultWritable)(dir)) throw new UserError(`The bot cannot write to ${dir}.`);
    const record: ProjectRecord = { name, path: dir, addedAt: Date.now() };
    this.store.update((d) => {
      d.projects[name] = record;
    });
    return record;
  }

  /** Remove a project. Tabs keep their own directory; chats using it switch to another project. */
  remove(name: string): void {
    if (!this.get(name)) throw new UserError(`No project named "${name}".`);
    const remaining = this.list().filter((p) => p.name !== name);
    if (remaining.length === 0) throw new UserError("Keep at least one project.");
    this.store.update((d) => {
      delete d.projects[name];
      for (const chat of Object.values(d.chats)) {
        if (chat.activeProject === name) chat.activeProject = remaining[0].name;
      }
    });
  }

  /** The project new tabs in this chat start in. */
  activeFor(chatId: number): ProjectRecord {
    const chat = this.chats.ensure(chatId);
    const project = this.get(chat.activeProject) ?? this.list()[0];
    if (!project) throw new UserError("No projects yet. Add one with /project add <name> <path>.");
    if (project.name !== chat.activeProject) this.chats.setActiveProject(chatId, project.name);
    return project;
  }

  use(chatId: number, name: string): ProjectRecord {
    const project = this.get(name);
    if (!project) throw new UserError(`No project named "${name}". See /projects.`);
    this.chats.setActiveProject(chatId, name);
    return project;
  }

  /** First start: register DEFAULT_CWD as project "home" (skipping the ALLOWED_ROOTS check). */
  bootstrap(defaultCwd: string): void {
    if (this.list().length > 0) return;
    const dir = path.resolve(defaultCwd);
    this.store.update((d) => {
      d.projects.home = { name: "home", path: dir, addedAt: Date.now() };
    });
  }
}
