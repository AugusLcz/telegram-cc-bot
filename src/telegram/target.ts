import type { Context } from "grammy";
import { threadKey, type Target, type ThreadKey } from "../core/types.ts";

/** The "General" topic: not a session chat; addressed without a thread ID. */
export const GENERAL_THREAD_ID = 1;

/** `message_thread_id` parameter for a target (omitted outside chats). */
export function threadParams(t: Target): { message_thread_id?: number } {
  return t.threadId && t.threadId !== GENERAL_THREAD_ID ? { message_thread_id: t.threadId } : {};
}

/** Classify a message: inside a tab when it carries a non-General thread ID. */
export function targetFromMessage(chatId: number, msg: { message_thread_id?: number } | undefined): Target {
  const id = msg?.message_thread_id;
  return id && id !== GENERAL_THREAD_ID ? { chatId, threadId: id } : { chatId };
}

/** Target of an update (message or button press), if it has a chat. */
export function targetOf(ctx: Context): Target | undefined {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return undefined;
  const msg = ctx.msg ?? (ctx.callbackQuery?.message as { message_thread_id?: number } | undefined);
  return targetFromMessage(chatId, msg);
}

export function keyOf(t: Target): ThreadKey | undefined {
  return t.threadId === undefined ? undefined : threadKey(t.chatId, t.threadId);
}

/** Ordering key for update processing: per chat (topic), or per bot root outside chats. */
export function sequenceKey(ctx: Context): string | undefined {
  const t = targetOf(ctx);
  return t ? `${t.chatId}:${t.threadId ?? "main"}` : undefined;
}
