import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { silentLogger, type Logger } from "../core/logger.ts";
import type { Target } from "../core/types.ts";
import type { ChatBudget } from "./limiter.ts";
import { editHtml, sendHtml, TopicGoneError } from "./send.ts";

export interface WorkingOptions {
  budget: ChatBudget;
  /** Buttons under the message (Stop). */
  keyboard?: InlineKeyboardMarkup;
  /** Wait this long before showing it, so quick replies don't flash it. */
  delayMs?: number;
  /** How often the elapsed time is updated. */
  tickMs?: number;
  log?: Logger;
  onTopicGone?: (err: TopicGoneError) => void;
}

/** "45s", "1m 20s", "1h 5m". */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * The "⏳ Working…" message of a tab while a turn runs. It is kept as the
 * chat's last message (moved below anything sent meanwhile), hidden while
 * Claude waits for the user, and deleted before the answer is sent, so the
 * answer arrives as a new message with a notification.
 */
export class WorkingMessage {
  private readonly api: Api;
  private readonly target: Target;
  private readonly opts: WorkingOptions;
  private readonly log: Logger;

  /** A turn is running. */
  active = false;
  private paused = false;
  private startedAt = 0;
  private msgId: number | null = null;
  private showing: Promise<void> | null = null;
  /** Bumped on every hide: a send that returns afterwards deletes its message. */
  private gen = 0;
  private delayTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(api: Api, target: Target, opts: WorkingOptions) {
    this.api = api;
    this.target = target;
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
  }

  /** A turn started (idempotent). */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.delayTimer = setTimeout(() => {
      this.delayTimer = null;
      void this.show();
    }, this.opts.delayMs ?? 2000);
    this.delayTimer.unref();
  }

  /** The turn ended: remove the message. */
  async stop(): Promise<void> {
    this.active = false;
    this.paused = false;
    await this.hide();
  }

  /** Claude waits for the user (a prompt is open). */
  async pause(): Promise<void> {
    this.paused = true;
    await this.hide();
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    await this.show();
  }

  /** Send something during the turn, keeping this message below it. */
  async sendAbove<T>(send: () => Promise<T>): Promise<T> {
    const shown = this.msgId !== null || this.showing !== null;
    if (shown) await this.hide();
    try {
      return await send();
    } finally {
      if (shown) await this.show();
    }
  }

  /** Stop timers and drop the message without waiting (process gone, tab closed). */
  dispose(): void {
    this.active = false;
    this.paused = false;
    this.gen++;
    this.clearTimers();
    const id = this.msgId;
    this.msgId = null;
    if (id !== null) this.api.deleteMessage(this.target.chatId, id).catch(() => {});
  }

  private html(): string {
    const ms = Date.now() - this.startedAt;
    return ms < 5000 ? "⏳ Working…" : `⏳ Working… ${elapsed(ms)}`;
  }

  private async show(): Promise<void> {
    if (!this.active || this.paused || this.msgId !== null || this.showing) return;
    const gen = this.gen;
    this.showing = (async () => {
      try {
        const id = await sendHtml(this.api, this.target, this.html(), { keyboard: this.opts.keyboard, silent: true });
        if (gen !== this.gen) await this.api.deleteMessage(this.target.chatId, id).catch(() => {});
        else {
          this.msgId = id;
          this.tick();
        }
      } catch (err) {
        this.report(err);
      } finally {
        this.showing = null;
      }
    })();
    await this.showing;
  }

  private async hide(): Promise<void> {
    this.gen++;
    this.clearTimers();
    if (this.showing) await this.showing; // it sees the new generation and deletes its message
    const id = this.msgId;
    this.msgId = null;
    if (id !== null) await this.api.deleteMessage(this.target.chatId, id).catch(() => {});
  }

  private tick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      const id = this.msgId;
      if (id === null || !this.opts.budget.take(this.target.chatId)) return;
      editHtml(this.api, this.target, id, this.html(), this.opts.keyboard).catch((err) => this.report(err));
    }, this.opts.tickMs ?? 10_000);
    this.tickTimer.unref();
  }

  private clearTimers(): void {
    if (this.delayTimer) clearTimeout(this.delayTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.delayTimer = null;
    this.tickTimer = null;
  }

  private report(err: unknown): void {
    if (err instanceof TopicGoneError) this.opts.onTopicGone?.(err);
    else this.log.debug("working message failed:", err);
  }
}
