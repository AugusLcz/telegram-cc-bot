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
 * Long-polls Telegram and keeps doing so. grammY's runner gives up on a 409
 * (another process polls the same token) and on a 401; left unhandled, that
 * crashes the bot and systemd restarts it every few seconds, stealing updates
 * back and forth with the other poller. Instead, a conflict is logged clearly
 * and retried with growing pauses, and a 401 is reported once as fatal.
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
    if (code === 401) {
      this.log.error("Telegram 401: Unauthorized: the bot token was rejected; check TELEGRAM_BOT_TOKEN");
      this.opts.onFatal(err);
      return;
    }
    let delay: number;
    if (code === 409) {
      this.conflicts++;
      delay = (this.opts.conflictDelay ?? defaultConflictDelay)(this.conflicts);
      this.log.error(
        `Telegram 409: Conflict: another process is polling this bot token (a second copy of this bot, OpenClaw, ` +
          `a \`claude --channels\` session, another machine…). Only one may poll; stop the other one or give this bot ` +
          `its own token. Retrying in ${delay}s (conflict #${this.conflicts}).`,
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
