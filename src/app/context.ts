import { InlineKeyboard, type Api } from "grammy";
import type { CommandCatalog } from "../claude/catalog.ts";
import type { CommandNameMap } from "../claude/cmdnames.ts";
import type { SessionPool } from "../claude/pool.ts";
import type { ProcessFactory } from "../claude/process.ts";
import type { SessionApi } from "../claude/sessions.ts";
import type { Config } from "../core/config.ts";
import type { Exec } from "../core/exec.ts";
import type { Logger } from "../core/logger.ts";
import { targetOfKey, type ThreadKey } from "../core/types.ts";
import type { AccessControl } from "../domain/access.ts";
import type { ChatService } from "../domain/chats.ts";
import type { ProjectService } from "../domain/projects.ts";
import type { ThreadService } from "../domain/threads.ts";
import type { Store } from "../store/store.ts";
import type { ChatBudget } from "../telegram/limiter.ts";
import type { PermissionBroker } from "../telegram/permissions.ts";
import { TurnRenderer, type StreamModeRef } from "../telegram/render.ts";
import type { TopicGoneError } from "../telegram/send.ts";
import { callbackData, type CallbackRouter, type CommandRegistry } from "./registry.ts";

export interface BotInfo {
  username: string;
  /** Threaded Mode (topics in private chats) is enabled in @BotFather. */
  hasTopics: boolean;
  /** Users may open new chats (topics) themselves; a BotFather setting. */
  usersCreateTopics: boolean;
}

/** Everything handlers need. Built once in app/bot.ts (createApp). */
export interface App {
  cfg: Config;
  log: Logger;
  api: Api;
  botInfo: BotInfo;
  store: Store;
  access: AccessControl;
  chats: ChatService;
  projects: ProjectService;
  threads: ThreadService;
  pool: SessionPool;
  /** Starts Claude Code processes; also used for short probes outside the pool. */
  factory: ProcessFactory;
  sessions: SessionApi;
  /** Runs helper programs (git, the claude CLI). */
  exec: Exec;
  catalog: CommandCatalog;
  names: CommandNameMap;
  broker: PermissionBroker;
  renderers: RendererRegistry;
  commands: CommandRegistry<App>;
  callbacks: CallbackRouter<App>;
  startedAt: number;
  /**
   * Names of chats Telegram announced (forum_topic_created) that have no
   * record yet. A record is only created once the chat needs a session, so
   * chats used just for bot commands leave nothing behind.
   */
  topicNames: Map<ThreadKey, { name: string; implicit: boolean }>;
  /** Chats whose session-start line was already posted (this process). */
  announced: Set<ThreadKey>;
  /** A send found the tab deleted. */
  onTopicGone(key: ThreadKey): Promise<void>;
}

/** Timing of the working message (shorter in tests). */
export interface WorkingTiming {
  delayMs?: number;
  tickMs?: number;
}

/** One TurnRenderer per tab, created on demand. */
export class RendererRegistry {
  private readonly map = new Map<ThreadKey, TurnRenderer>();
  private readonly api: Api;
  private readonly stream: StreamModeRef;
  private readonly budget: ChatBudget;
  private readonly thinking: (key: ThreadKey) => boolean;
  private readonly working: WorkingTiming;
  private readonly log: Logger;
  private readonly onGone: (key: ThreadKey, err: TopicGoneError) => void;
  private readonly stopKeyboard = new InlineKeyboard().text("⏹ Stop", callbackData("stop", ""));

  constructor(opts: {
    api: Api;
    stream: StreamModeRef;
    budget: ChatBudget;
    thinking: (key: ThreadKey) => boolean;
    working?: WorkingTiming;
    log: Logger;
    onGone: (key: ThreadKey, err: TopicGoneError) => void;
  }) {
    this.api = opts.api;
    this.stream = opts.stream;
    this.budget = opts.budget;
    this.thinking = opts.thinking;
    this.working = opts.working ?? {};
    this.log = opts.log;
    this.onGone = opts.onGone;
  }

  get(key: ThreadKey): TurnRenderer {
    let r = this.map.get(key);
    if (!r) {
      r = new TurnRenderer(this.api, targetOfKey(key), {
        thinking: () => this.thinking(key),
        stream: this.stream,
        budget: this.budget,
        workingKeyboard: this.stopKeyboard,
        workingDelayMs: this.working.delayMs,
        workingTickMs: this.working.tickMs,
        log: this.log.child(key),
        onTopicGone: (err) => this.onGone(key, err),
      });
      this.map.set(key, r);
    }
    return r;
  }

  /** The tab's renderer if it has one (without creating it). */
  find(key: ThreadKey): TurnRenderer | undefined {
    return this.map.get(key);
  }

  dispose(key: ThreadKey): void {
    this.map.get(key)?.dispose();
    this.map.delete(key);
  }
}
