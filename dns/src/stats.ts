import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Decision = "allow" | "block";

const dbPath = process.env.STATS_DB_PATH ?? "/stats/stats.sqlite";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    queries INTEGER NOT NULL DEFAULT 0,
    allowed INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO stats (id, queries, allowed, blocked)
  VALUES (1, 0, 0, 0);

  CREATE TABLE IF NOT EXISTS domains (
    domain TEXT PRIMARY KEY,
    domain_key TEXT NOT NULL UNIQUE,
    total INTEGER NOT NULL DEFAULT 0,
    allowed INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_domains_total
    ON domains(total DESC);

  CREATE INDEX IF NOT EXISTS idx_domains_allowed
    ON domains(allowed DESC);

  CREATE INDEX IF NOT EXISTS idx_domains_blocked
    ON domains(blocked DESC);
`);

const bumpStats = db.prepare(`
  UPDATE stats
  SET
    queries = queries + 1,
    allowed = allowed + ?,
    blocked = blocked + ?
  WHERE id = 1
`);

const bumpDomain = db.prepare(`
  INSERT INTO domains(domain, domain_key, total, allowed, blocked)
  VALUES (?, ?, 1, ?, ?)
  ON CONFLICT(domain) DO UPDATE SET
    total = total + 1,
    allowed = allowed + excluded.allowed,
    blocked = blocked + excluded.blocked
`);

const readStats = db.prepare(`
  SELECT queries, allowed, blocked
  FROM stats
  WHERE id = 1
`);

const readDomainByKey = db.prepare(`
  SELECT domain
  FROM domains
  WHERE domain_key = ?
  LIMIT 1
`);

export function statsReady(): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export async function ensureStatsReady(_timeoutMs?: number): Promise<boolean> {
  return statsReady();
}

export function makeDomainKey(domain: string): string {
  return crypto.createHash("sha256").update(domain).digest("hex").slice(0, 16);
}

export async function recordQuery(domain: string, decision: Decision): Promise<void> {
  const allowed = decision === "allow" ? 1 : 0;
  const blocked = decision === "block" ? 1 : 0;
  const key = makeDomainKey(domain);

  try {
    db.exec("BEGIN IMMEDIATE");
    bumpStats.run(allowed, blocked);
    bumpDomain.run(domain, key, allowed, blocked);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    console.error(
      "sqlite-record-query-failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getStats() {
  const row = readStats.get() as {
    queries?: number;
    allowed?: number;
    blocked?: number;
  } | undefined;

  const queries = toNumber(row?.queries);
  const allowed = toNumber(row?.allowed);
  const blocked = toNumber(row?.blocked);

  return {
    queries,
    allowed,
    blocked,
    blockRate: queries === 0 ? 0 : Number(((blocked / queries) * 100).toFixed(2)),
  };
}

export async function getTop(decision: Decision, limit = 10) {
  const column = decision === "block" ? "blocked" : "allowed";
  const statement = db.prepare(`
    SELECT domain, ${column} AS count
    FROM domains
    WHERE ${column} > 0
    ORDER BY ${column} DESC, domain ASC
    LIMIT ?
  `);

  return (statement.all(limit) as Array<{ domain: string; count: number }>).map(row => ({
    domain: row.domain,
    count: toNumber(row.count),
  }));
}

export async function getDomains(limit = 8, offset = 0) {
  const totalRow = db.prepare("SELECT COUNT(*) AS total FROM domains").get() as {
    total?: number;
  };

  const rows = db.prepare(`
    SELECT domain, domain_key, total
    FROM domains
    ORDER BY total DESC, domain ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<{
    domain: string;
    domain_key: string;
    total: number;
  }>;

  return {
    total: toNumber(totalRow?.total),
    items: rows.map(row => ({
      key: row.domain_key,
      domain: row.domain,
      count: toNumber(row.total),
    })),
  };
}

export async function resolveDomainKey(key: string): Promise<string | undefined> {
  const row = readDomainByKey.get(key) as { domain?: string } | undefined;
  return row?.domain;
}
