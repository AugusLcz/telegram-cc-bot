/**
 * Per-chat token bucket for best-effort traffic (live previews, status
 * edits). Several tabs stream into the same chat, and Telegram limits
 * messages per chat; when the budget is spent, best-effort updates are
 * skipped. Final replies never go through this.
 */
export class ChatBudget {
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly buckets = new Map<number, { tokens: number; at: number }>();

  constructor(ratePerSec = 3, burst = 4) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
  }

  take(chatId: number, now = Date.now()): boolean {
    const b = this.buckets.get(chatId) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.ratePerSec);
    b.at = now;
    this.buckets.set(chatId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
