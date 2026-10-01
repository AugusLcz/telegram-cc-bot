import type { ChatRecord, SessionSettings } from "../core/types.ts";
import type { Store } from "../store/store.ts";

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
