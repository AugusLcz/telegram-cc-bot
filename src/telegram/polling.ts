import { run, type RunnerHandle } from "@grammyjs/runner";
import { GrammyError, type Bot } from "grammy";
import { silentLogger, type Logger } from "../core/logger.ts";

export interface PollerOptions {
  log?: Logger;
  /** The token is invalid (401): polling cannot work, so the caller should stop. */
  onFatal: (err: unknown) => void;
  /** Seconds to wait before retrying after the n-th consecutive conflict (n ≥ 1). */
  conflictDelay?: (n: number) => number;
  /** Seconds to wait before retrying after any other polling failure. */
  errorDelay?: number;
  /** Polling this long without a conflict resets the conflict backoff. */
  healthyAfterMs?: number;
  /** Injectable for tests. */
  runFn?: (bot: Bot) => RunnerHandle;
}

/** 15 s, 30 s, 1 min, 2 min, then every 5 min. */
export function defaultConflictDelay(n: number): number {
  return Math.min(300, 15 * 2 ** (n - 1));
}

const runBot = (bot: Bot) => run(bot, { runner: { fetch: { allowed_updates: ["message", "callback_query"] } } });

/**
 * Long-polls Telegram and keeps doing so. This is the bot's only getUpdates
 * loop: Claude Code sessions never talk to Telegram, and one runner runs at a
 * time (a new one starts only after the previous one failed). grammY's runner
 * gives up on a 409 (another client polls the same token) and on a 401; left
 * unhandled, that crashes the bot and systemd restarts it every few seconds,
 * stealing updates back and forth with the other client. Instead, a conflict is
 * logged with Telegram's own words and retried with growing pauses, a webhook
 * set meanwhile is removed, and a 401 is reported once as fatal.
 */
export class Poller {
  private readonly bot: Bot;
  private readonly opts: PollerOptions;
  private readonly log: Logger;
  private runner: RunnerHandle | null = null;
  private stopped = false;
  private conflicts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;

  constructor(bot: Bot, opts: PollerOptions) {
    this.bot = bot;
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
  }

  get conflictCount(): number {
    return this.conflicts;
  }

  start(): void {
    if (this.stopped) return;
    const runner = (this.opts.runFn ?? runBot)(this.bot);
    this.runner = runner;
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.healthyTimer = setTimeout(() => {
      if (runner.isRunning()) this.conflicts = 0;
    }, this.opts.healthyAfterMs ?? 120_000);
    this.healthyTimer.unref();
    runner.task()?.catch((err) => this.onError(err));
  }

  private onError(err: unknown): void {
    if (this.stopped) return;
    const code = err instanceof GrammyError ? err.error_code : undefined;
    const description = err instanceof GrammyError ? err.description : "";
    if (code === 401) {
      this.log.error("Telegram 401: Unauthorized: the bot token was rejected; check TELEGRAM_BOT_TOKEN");
      this.opts.onFatal(err);
      return;
    }
    let delay: number;
    if (code === 409 && /webhook/i.test(description)) {
      // Someone set a webhook after we started: polling gets nothing until it is gone.
      delay = this.opts.errorDelay ?? 10;
      this.log.warn(`Telegram 409: ${description}. Removing the webhook (this bot uses long polling); retrying in ${delay}s`);
      this.bot.api.deleteWebhook().catch((e) => this.log.warn("deleteWebhook failed:", e));
    } else if (code === 409) {
      // Telegram ends a waiting getUpdates this way when a newer one for the same token arrives.
      this.conflicts++;
      delay = (this.opts.conflictDelay ?? defaultConflictDelay)(this.conflicts);
      this.log.error(
        `Telegram 409: ${description || "Conflict"}. Another client asked for this bot's updates while this one ` +
          `(pid ${process.pid}) was waiting; Telegram serves only one. Retrying in ${delay}s (conflict #${this.conflicts}). ` +
          `\`sudo deploy/deploy.sh check\` lists local processes using the token.`,
      );
    } else {
      delay = this.opts.errorDelay ?? 10;
      this.log.error(`polling stopped unexpectedly; retrying in ${delay}s:`, err);
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay * 1000);
  }

  isRunning(): boolean {
    return this.runner?.isRunning() ?? false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    if (this.runner?.isRunning()) await this.runner.stop();
  }
}
