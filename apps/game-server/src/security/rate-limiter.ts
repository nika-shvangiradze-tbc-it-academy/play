interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory sliding-window style rate limiter (per-key, fixed window).
 * Suitable for single-node MVP; replace with Redis for multi-node production.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the action is allowed. */
  tryRemoveToken(key: string): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (existing.count >= this.maxPerWindow) {
      return false;
    }
    existing.count += 1;
    return true;
  }

  remaining(key: string): number {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      return this.maxPerWindow;
    }
    return Math.max(0, this.maxPerWindow - existing.count);
  }
}
