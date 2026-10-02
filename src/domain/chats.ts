import type { ChatRecord, SessionSettings, ThreadRecord } from "../core/types.ts";
import type { Store } from "../store/store.ts";

/**
 * Chat ↔ session bindings belong to one bot. A private chat's ID is the user's
 * ID whichever bot it is with, but its chats (topic IDs) are the bot's own, so
 * after a token change a new chat would land on an old chat's session. When the
 * bot changes, its bindings are put aside (and restored if it comes back) and
 * the new bot gets its own, if it had any; projects and defaults stay. A state
 * written before the bot was recorded is taken as this bot's: nothing is lost.
 */
export function claimStateForBot(store: Store, botId: number): { archived: number; restored: number } {
  const prev = store.data.botId;
  const result = { archived: 0, restored: 0 };
  if (prev === botId) return result;
  store.update((d) => {
    d.botId = botId;
    if (prev === undefined) return;
    const archive = (d.botArchive ??= {});
    const aside: Record<string, Record<string, ThreadRecord>> = {};
    for (const [chatId, chat] of Object.entries(d.chats)) {
      const n = Object.keys(chat.threads).length;
      if (n) aside[chatId] = chat.threads;
      result.archived += n;
      chat.threads = {};
    }
    const back = archive[String(botId)] ?? {};
    delete archive[String(botId)];
    if (result.archived) archive[String(prev)] = aside;
    for (const [chatId, threads] of Object.entries(back)) {
      const chat = d.chats[chatId];
      if (!chat) continue;
      chat.threads = threads;
      result.restored += Object.keys(threads).length;
    }
  });
  return result;
}

/** Per-chat records: active project and defaults for new tabs. */
export class ChatService {
  private readonly store: Store;
  private readonly initialDefaults: () => SessionSettings;

  constructor(store: Store, initialDefaults: () => SessionSettings) {
    this.store = store;
    this.initialDefaults = initialDefaults;
  }

  get(chatId: number): ChatRecord | undefined {
    return this.store.data.chats[String(chatId)];
  }

  ensure(chatId: number): ChatRecord {
    const existing = this.get(chatId);
    if (existing) return existing;
    const record: ChatRecord = { activeProject: "", defaults: this.initialDefaults(), threads: {} };
    this.store.update((d) => {
      d.chats[String(chatId)] = record;
    });
    return record;
  }

  chatIds(): number[] {
    return Object.keys(this.store.data.chats).map(Number);
  }

  setDefaults(chatId: number, patch: Partial<SessionSettings>): SessionSettings {
    const chat = this.ensure(chatId);
    this.store.update(() => {
      Object.assign(chat.defaults, patch);
      for (const k of Object.keys(patch) as (keyof SessionSettings)[]) {
        if (patch[k] === undefined) delete chat.defaults[k];
      }
    });
    return chat.defaults;
  }

  setActiveProject(chatId: number, name: string): void {
    const chat = this.ensure(chatId);
    this.store.update(() => {
      chat.activeProject = name;
    });
  }
}
