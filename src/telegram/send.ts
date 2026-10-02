import { GrammyError, InputFile, type Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Target } from "../core/types.ts";
import { markdownToTelegramHtml, splitMarkdown } from "./format.ts";
import { threadParams } from "./target.ts";

/** Above this many chunks a reply is sent as a .md file plus a short preview. */
const MAX_INLINE_CHUNKS = 4;

/** The tab no longer exists (deleted by the user). */
export class TopicGoneError extends Error {
  readonly target: Target;
  constructor(target: Target, cause?: unknown) {
    super(`topic ${target.threadId} in chat ${target.chatId} is gone`, { cause });
    this.name = "TopicGoneError";
    this.target = target;
  }
}

export function isTopicGoneError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    /message thread not found|thread not found|topic_deleted|topic was deleted|TOPIC_ID_INVALID/i.test(err.description)
  );
}

function isParseError(err: unknown): boolean {
  return err instanceof GrammyError && /can't parse entities|unsupported start tag|can't find end/i.test(err.description);
}

/** Run a Bot API call aimed at `target`, translating "thread not found" into TopicGoneError. */
export async function call<T>(target: Target, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (target.threadId !== undefined && isTopicGoneError(err)) throw new TopicGoneError(target, err);
    throw err;
  }
}

const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

/** Send HTML; if Telegram rejects the markup, resend as plain text. Returns the message ID. */
export async function sendHtml(
  api: Api,
  target: Target,
  html: string,
  opts: { plain?: string; keyboard?: InlineKeyboardMarkup } = {},
): Promise<number> {
  const base = { ...threadParams(target), ...NO_PREVIEW, reply_markup: opts.keyboard };
  return call(target, async () => {
    try {
      return (await api.sendMessage(target.chatId, html, { ...base, parse_mode: "HTML" })).message_id;
    } catch (err) {
      if (!isParseError(err)) throw err;
      return (await api.sendMessage(target.chatId, opts.plain ?? html.replace(/<[^>]+>/g, ""), base)).message_id;
    }
  });
}

/** Edit a message's HTML; ignores "not modified", falls back to plain text on markup errors. */
export async function editHtml(
  api: Api,
  target: Target,
  messageId: number,
  html: string,
  keyboard?: InlineKeyboardMarkup,
): Promise<void> {
  try {
    await api.editMessageText(target.chatId, messageId, html, { parse_mode: "HTML", ...NO_PREVIEW, reply_markup: keyboard });
  } catch (err) {
    if (err instanceof GrammyError && /message is not modified/i.test(err.description)) return;
    if (!isParseError(err)) throw err;
    await api.editMessageText(target.chatId, messageId, html.replace(/<[^>]+>/g, ""), { reply_markup: keyboard });
  }
}

/** Send Claude's Markdown, split into Telegram-sized messages (or a file when very long). */
export async function sendMarkdown(api: Api, target: Target, md: string): Promise<void> {
  if (!md.trim()) return;
  const chunks = splitMarkdown(md);
  if (chunks.length > MAX_INLINE_CHUNKS) {
    await sendHtml(api, target, markdownToTelegramHtml(chunks[0]), { plain: chunks[0] });
    await call(target, () =>
      api.sendDocument(target.chatId, new InputFile(Buffer.from(md, "utf8"), "reply.md"), {
        ...threadParams(target),
        caption: `Full reply (${md.length} chars)`,
      }),
    );
    return;
  }
  for (const chunk of chunks) {
    await sendHtml(api, target, markdownToTelegramHtml(chunk), { plain: chunk });
  }
}

/** Send a file built in memory. */
export async function sendFile(api: Api, target: Target, name: string, data: Buffer | string, caption?: string): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  await call(target, () => api.sendDocument(target.chatId, new InputFile(buf, name), { ...threadParams(target), caption }));
}

export async function sendPlain(api: Api, target: Target, text: string): Promise<number> {
  return call(target, async () => (await api.sendMessage(target.chatId, text, threadParams(target))).message_id);
}

export async function sendDraft(api: Api, target: Target, draftId: number, text: string): Promise<void> {
  await call(target, () => api.sendMessageDraft(target.chatId, draftId, text, threadParams(target)));
}

export async function sendTyping(api: Api, target: Target): Promise<void> {
  await api.sendChatAction(target.chatId, "typing", threadParams(target));
}
