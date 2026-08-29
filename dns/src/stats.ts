import crypto from "node:crypto";
import { createClient } from "redis";

export type Decision = "allow" | "block";

const redisUrl = process.env.REDIS_URL ?? "redis://redis:6379";

const client = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: retries => Math.min(250 * Math.max(retries, 1), 5000),
  },
});

client.on("error", error => {
  console.error("redis-error", error instanceof Error ? error.message : String(error));
});

let connectPromise: Promise<void> | null = null;

async function startConnect(): Promise<void> {
  if (client.isReady || client.isOpen) return;

  if (!connectPromise) {
    connectPromise = client
      .connect()
      .then(() => undefined)
      .finally(() => {
        connectPromise = null;
      });
  }

  await connectPromise;
}

export async function ensureStatsReady(timeoutMs = 2500): Promise<boolean> {
  if (client.isReady) return true;

  if (!client.isOpen) {
    try {
      const connect = startConnect();
      await Promise.race([
        connect,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("redis connect timeout")), timeoutMs),
        ),
      ]);
    } catch (error) {
      console.error(
        "redis-connect-attempt-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (client.isReady) return true;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.isReady) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return client.isReady;
}

void ensureStatsReady(1000);

const KEYS = {
  stats: "adblock:stats",
  allDomains: "adblock:domains:all",
  allowedDomains: "adblock:domains:allow",
  blockedDomains: "adblock:domains:block",
  domainKeys: "adblock:domain-keys",
} as const;

export function statsReady(): boolean {
  return client.isReady;
}

export function makeDomainKey(domain: string): string {
  return crypto.createHash("sha256").update(domain).digest("hex").slice(0, 16);
}

export async function recordQuery(domain: string, decision: Decision): Promise<void> {
  if (!(await ensureStatsReady(500))) return;

  const key = makeDomainKey(domain);
  const decisionKey = decision === "block" ? KEYS.blockedDomains : KEYS.allowedDomains;

  try {
    await client
      .multi()
      .hIncrBy(KEYS.stats, "queries", 1)
      .hIncrBy(KEYS.stats, decision === "block" ? "blocked" : "allowed", 1)
      .zIncrBy(KEYS.allDomains, 1, domain)
      .zIncrBy(decisionKey, 1, domain)
      .hSet(KEYS.domainKeys, key, domain)
      .exec();
  } catch (error) {
    console.error(
      "redis-record-query-failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseCount(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function requireStatsReady(): Promise<void> {
  if (!(await ensureStatsReady())) {
    throw new Error("statistics storage unavailable");
  }
}

export async function getStats() {
  await requireStatsReady();

  const values = await client.hGetAll(KEYS.stats);
  const queries = parseCount(values.queries);
  const allowed = parseCount(values.allowed);
  const blocked = parseCount(values.blocked);

  return {
    queries,
    allowed,
    blocked,
    blockRate: queries === 0 ? 0 : Number(((blocked / queries) * 100).toFixed(2)),
  };
}

async function zRevRangeWithScores(key: string, start: number, stop: number) {
  await requireStatsReady();

  const raw = await client.sendCommand([
    "ZREVRANGE",
    key,
    String(start),
    String(stop),
    "WITHSCORES",
  ]) as string[];

  const result: Array<{ domain: string; count: number }> = [];
  for (let i = 0; i < raw.length; i += 2) {
    result.push({
      domain: raw[i],
      count: Number(raw[i + 1] ?? 0),
    });
  }
  return result;
}

export async function getTop(decision: Decision, limit = 10) {
  const key = decision === "block" ? KEYS.blockedDomains : KEYS.allowedDomains;
  return zRevRangeWithScores(key, 0, Math.max(limit - 1, 0));
}

export async function getDomains(limit = 8, offset = 0) {
  await requireStatsReady();

  const total = await client.zCard(KEYS.allDomains);
  const items = await zRevRangeWithScores(
    KEYS.allDomains,
    offset,
    Math.max(offset + limit - 1, offset),
  );

  return {
    total,
    items: items.map(item => ({
      key: makeDomainKey(item.domain),
      ...item,
    })),
  };
}

export async function resolveDomainKey(key: string): Promise<string | undefined> {
  if (!(await ensureStatsReady())) return undefined;
  return (await client.hGet(KEYS.domainKeys, key)) ?? undefined;
}
