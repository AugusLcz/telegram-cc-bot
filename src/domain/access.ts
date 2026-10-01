/** Allowlist from `.env`, plus a rate limit for "your ID is …" replies to strangers. */
export class AccessControl {
  private readonly allowed: Set<number>;
  private readonly cooldownMs: number;
  private readonly lastReply = new Map<number, number>();

  constructor(allowed: Set<number>, cooldownMs = 10 * 60_000) {
    this.allowed = allowed;
    this.cooldownMs = cooldownMs;
  }

  isAllowed(userId: number | undefined): boolean {
    return userId !== undefined && this.allowed.has(userId);
  }

  /** True at most once per cooldown per user. */
  shouldReply(userId: number, now = Date.now()): boolean {
    const last = this.lastReply.get(userId);
    if (last !== undefined && now - last < this.cooldownMs) return false;
    this.lastReply.set(userId, now);
    return true;
  }
}
