import type { Api } from "grammy";
import type { Target } from "../core/types.ts";
import { call } from "./send.ts";

const NAME_MAX = 128;
const TITLE_MAX = 40;

/** A valid topic name: single line, 1–128 chars. */
export function topicName(name: string, fallback = "Session"): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return (clean || fallback).slice(0, NAME_MAX);
}

/** Short tab title derived from a prompt: first meaningful line, at most 40 chars. */
export function titleFromPrompt(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find((l) => l.length > 0) ?? "";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return (space > TITLE_MAX / 2 ? cut.slice(0, space) : cut) + "…";
}

/** Topic operations in private chats (implements the domain's TopicGateway port). */
export class TelegramTopics {
  private readonly api: Api;
  constructor(api: Api) {
    this.api = api;
  }

  async create(chatId: number, name: string): Promise<number> {
    const topic = await this.api.createForumTopic(chatId, topicName(name));
    return topic.message_thread_id;
  }

  async rename(target: Target, name: string): Promise<void> {
    await call(target, () => this.api.editForumTopic(target.chatId, target.threadId!, { name: topicName(name) }));
  }

  async remove(target: Target): Promise<void> {
    await call(target, () => this.api.deleteForumTopic(target.chatId, target.threadId!));
  }
}
