import { describe, expect, it } from "vitest";
import { DnsRateLimiter } from "../src/rate-limit.js";

describe("DNS rate limiter", () => {
  it("allows a burst, rejects excess, and refills", () => {
    const limiter = new DnsRateLimiter(2, 2);
    expect(limiter.allow("client", 1000)).toBe(true);
    expect(limiter.allow("client", 1000)).toBe(true);
    expect(limiter.allow("client", 1000)).toBe(false);
    expect(limiter.allow("client", 1500)).toBe(true);
  });

  it("can be disabled with a zero rate", () => {
    const limiter = new DnsRateLimiter(0, 1);
    for (let i = 0; i < 100; i++) expect(limiter.allow("client", 0)).toBe(true);
  });

  it("rejects invalid configuration", () => {
    expect(() => new DnsRateLimiter(Number.NaN, 1)).toThrow(/invalid/);
    expect(() => new DnsRateLimiter(1, 0)).toThrow(/invalid/);
  });
});
