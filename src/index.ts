import { autoRetry } from "@grammyjs/auto-retry";
import { run } from "@grammyjs/runner";
import { Bot } from "grammy";
import { SdkProcessFactory } from "./claude/process.ts";
import { sdkSessionApi } from "./claude/sessions.ts";
import { loadConfig } from "./core/config.ts";
import { createLogger } from "./core/logger.ts";
import { JsonFileStore } from "./store/store.ts";
import { createApp, syncMenu } from "./app/bot.ts";

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);

const bot = new Bot(cfg.botToken);
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
try {
  await bot.init();
} catch (err) {
  log.error("Telegram getMe failed (check TELEGRAM_BOT_TOKEN and network):", err);
  process.exit(1);
}
const me = bot.botInfo;
const botInfo = {
  username: me.username,
  hasTopics: me.has_topics_enabled === true,
  usersCreateTopics: me.allows_users_to_create_topics === true,
};
if (!botInfo.hasTopics) log.warn("Threaded Mode is off in @BotFather: the bot cannot keep separate sessions until it is enabled");

const store = new JsonFileStore(cfg.stateFile, { log: log.child("store") });
const factory = new SdkProcessFactory({ claudePath: cfg.claudePath, log: log.child("claude") });
const app = createApp({ cfg, bot, botInfo, factory, store, sessions: sdkSessionApi, log });

let menuTimer: NodeJS.Timeout | null = null;
const scheduleMenu = () => {
  if (menuTimer) clearTimeout(menuTimer);
  menuTimer = setTimeout(() => syncMenu(app).catch((err) => log.warn("setMyCommands failed:", err)), 2000);
};
app.catalog.onChange(scheduleMenu);
await syncMenu(app).catch((err) => log.warn("setMyCommands failed:", err));

// Read Claude Code's commands and models once, in the first project, without starting a session.
const probeDir = app.projects.list()[0]?.path ?? cfg.defaultCwd;
app.catalog
  .probe(factory, probeDir, cfg.defaultPermissionMode, log)
  .then(() => log.info(`Claude Code ready: ${app.catalog.commands.length} commands, ${app.catalog.models.length} models`))
  .catch((err) => log.error("Claude Code warm-up failed (will retry on first message):", err));

const runner = run(bot, { runner: { fetch: { allowed_updates: ["message", "callback_query"] } } });
log.info(
  `@${botInfo.username} polling · tabs ${botInfo.hasTopics ? "on" : "OFF"} · max ${cfg.maxLiveSessions} live sessions · idle ${cfg.sessionIdleMs / 60_000}m`,
);
// Chats that only ever saw bot commands keep no session; forget their leftovers after a week.
const pruned = app.threads.pruneEmpty(7 * 24 * 60 * 60_000);
if (pruned) log.info(`forgot ${pruned} chat(s) that never started a session`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received, shutting down`);
  if (runner.isRunning()) await runner.stop();
  app.broker.cancelAll();
  await app.pool.shutdown();
  await store.flush();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
