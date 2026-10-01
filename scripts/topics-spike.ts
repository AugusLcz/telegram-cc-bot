/**
 * Checks that topics in private chats work for this bot before relying on them.
 *
 *   TELEGRAM_BOT_TOKEN=… CHAT_ID=<your user id> bun scripts/topics-spike.ts
 *   (or: node --env-file=.env scripts/topics-spike.ts, with CHAT_ID set)
 *
 * Creates a temporary tab in your chat with the bot, exercises every call the
 * bot uses there, deletes the tab again (KEEP=1 keeps it) and verifies that
 * sending to a deleted tab is recognised. Stop the bot service first: only one
 * process may use the token.
 */
import { Api } from "grammy";
import { isTopicGoneError } from "../src/telegram/send.ts";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = Number(process.env.CHAT_ID ?? process.env.ALLOWED_USER_IDS?.split(",")[0]);
if (!token || !Number.isSafeInteger(chatId)) {
  console.error("Set TELEGRAM_BOT_TOKEN and CHAT_ID (your numeric Telegram user ID).");
  process.exit(2);
}

const api = new Api(token);
let failures = 0;
async function step(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const out = await fn();
    console.log(`✓ ${name}${out !== undefined && out !== true ? ` → ${JSON.stringify(out)}` : ""}`);
    return true;
  } catch (err) {
    failures++;
    console.log(`✗ ${name}: ${(err as { description?: string }).description ?? (err as Error).message}`);
    return false;
  }
}

const me = await api.getMe();
console.log(`bot @${me.username}: has_topics_enabled=${me.has_topics_enabled} allows_users_to_create_topics=${me.allows_users_to_create_topics}`);
if (!me.has_topics_enabled) {
  console.log("✗ Threaded Mode is off. Enable it in @BotFather → your bot → Bot Settings → Threaded Mode.");
  process.exit(1);
}

let thread = 0;
await step("createForumTopic in the private chat", async () => {
  thread = (await api.createForumTopic(chatId, "tg-cc-bot spike")).message_thread_id;
  return { message_thread_id: thread };
});
if (!thread) process.exit(1);
const inTab = { message_thread_id: thread };

await step("sendMessage into the tab", () => api.sendMessage(chatId, "1/5 message in a tab", inTab).then(() => true));
await step("sendChatAction (typing) in the tab", () => api.sendChatAction(chatId, "typing", inTab));
await step("sendMessageDraft (live preview) in the tab", () => api.sendMessageDraft(chatId, 4242, "2/5 streaming preview…", inTab));
await step("editMessageText in the tab", async () => {
  const m = await api.sendMessage(chatId, "3/5 will be edited", inTab);
  return api.editMessageText(chatId, m.message_id, "3/5 edited ✓").then(() => true);
});
await step("HTML formatting in the tab", () =>
  api.sendMessage(chatId, "4/5 <b>bold</b> <code>code</code>", { ...inTab, parse_mode: "HTML" }).then(() => true));
await step("editForumTopic (rename)", () => api.editForumTopic(chatId, thread, { name: "tg-cc-bot spike ✓" }));
await step("sendMessage without a thread (note where it shows up)", () =>
  api.sendMessage(chatId, "5/5 message sent without a thread").then(() => true));

if (process.env.KEEP === "1") {
  console.log("KEEP=1: leaving the tab in place.");
} else {
  await step("deleteForumTopic", () => api.deleteForumTopic(chatId, thread));
  await step("sending to the deleted tab is recognised as 'tab gone'", async () => {
    try {
      await api.sendMessage(chatId, "should fail", inTab);
    } catch (err) {
      if (isTopicGoneError(err)) return "recognised";
      throw new Error(`unexpected error: ${(err as { description?: string }).description ?? err}`);
    }
    throw new Error("sending to a deleted tab succeeded (deletion not effective?)");
  });
}

console.log(failures ? `\n${failures} step(s) failed` : "\nAll steps passed: tabs work for this bot.");
process.exit(failures ? 1 : 0);
