/**
 * Small in-process token-bucket rate limiter, keyed per principal (worker id,
 * or remote address for unauthenticated routes). In-process is sufficient:
 * the API is a single service; if it is ever replicated, move the buckets to
 * Postgres — the interface stays the same.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  allow(key: string, cost = 1): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    // Opportunistic cleanup so idle keys don't accumulate forever.
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) {
        if (now - v.updatedAt > 300_000) this.buckets.delete(k);
      }
    }
    return true;
  }
}
