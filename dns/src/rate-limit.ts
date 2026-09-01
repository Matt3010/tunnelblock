export class DnsRateLimiter {
  private readonly clients = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
  ) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond < 0 ||
        !Number.isFinite(burst) || burst < 1) {
      throw new Error("invalid DNS rate limit");
    }
  }

  allow(client: string, now = Date.now()): boolean {
    if (this.ratePerSecond === 0) return true;
    const previous = this.clients.get(client) ?? { tokens: this.burst, updatedAt: now };
    const elapsed = Math.max(0, now - previous.updatedAt) / 1000;
    const tokens = Math.min(this.burst, previous.tokens + elapsed * this.ratePerSecond);
    const allowed = tokens >= 1;
    this.clients.set(client, {
      tokens: allowed ? tokens - 1 : tokens,
      updatedAt: now,
    });

    if (this.clients.size > 4096) {
      const staleBefore = now - 10 * 60 * 1000;
      for (const [key, value] of this.clients) {
        if (value.updatedAt < staleBefore) this.clients.delete(key);
      }
    }
    return allowed;
  }
}
