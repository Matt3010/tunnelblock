import { createHash, timingSafeEqual } from "node:crypto";

type Clock = () => number;
export type Credentials = { user: string; password: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function parseBasicAuth(header: string | undefined): Credentials | null {
  const match = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

export function credentialsMatch(expected: Credentials, candidate: Credentials | null): boolean {
  if (!candidate) return false;
  // Both comparisons always run so timing does not reveal which part was wrong.
  const user = timingSafeEqual(digest(expected.user), digest(candidate.user));
  const password = timingSafeEqual(digest(expected.password), digest(candidate.password));
  return user && password;
}

export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(private readonly maxFailures: number, private readonly windowMs: number, private readonly now: Clock = Date.now) {}

  blocked(source: string): boolean {
    const entry = this.failures.get(source);
    if (!entry) return false;
    if (this.now() - entry.since >= this.windowMs) {
      this.failures.delete(source);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  fail(source: string): void {
    const entry = this.failures.get(source);
    if (!entry || this.now() - entry.since >= this.windowMs) {
      this.failures.set(source, { count: 1, since: this.now() });
      return;
    }
    entry.count++;
  }

  succeed(source: string): void {
    this.failures.delete(source);
  }
}
