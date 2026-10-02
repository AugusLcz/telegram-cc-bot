import type { ChatRecord, SessionSettings } from "../core/types.ts";
import type { Store } from "../store/store.ts";

/**
 * Chat ↔ session bindings belong to one bot. A private chat's ID is the user's
 * ID whichever bot it is with, but its chats (topic IDs) are the bot's own, so
 * after a token change a new chat would land on an old chat's session. When
 * the state was written for another bot (or before the bot was recorded), the
 * bindings are dropped; projects and defaults stay, and the old sessions remain
 * on disk for /resume. Returns how many bindings were dropped.
 */
export function claimStateForBot(store: Store, botId: number): number {
  if (store.data.botId === botId) return 0;
  let dropped = 0;
  store.update((d) => {
    for (const chat of Object.values(d.chats)) {
      dropped += Object.keys(chat.threads).length;
      chat.threads = {};
    }
    d.botId = botId;
  });
  return dropped;
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
