import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Decision = "allow" | "block";
export type YouTubeCaptureLabel = "ad" | "video";

export type YouTubeDomainComparison = {
  domain: string;
  adCount: number;
  videoCount: number;
  adSessions: number;
  videoSessions: number;
};

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

  CREATE TABLE IF NOT EXISTS youtube_sessions (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL CHECK (label IN ('ad', 'video')),
    started_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_youtube_sessions_label
    ON youtube_sessions(label, started_at DESC);

  CREATE TABLE IF NOT EXISTS youtube_capture (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    session_id TEXT,
    label TEXT,
    started_at TEXT
  );

  INSERT OR IGNORE INTO youtube_capture (id, session_id, label, started_at)
  VALUES (1, NULL, NULL, NULL);

  CREATE TABLE IF NOT EXISTS youtube_events (
    session_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    allowed INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (session_id, domain)
  );

  CREATE INDEX IF NOT EXISTS idx_youtube_events_session_total
    ON youtube_events(session_id, total DESC);
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

const readActiveYouTubeCapture = db.prepare(`
  SELECT session_id, label, started_at
  FROM youtube_capture
  WHERE id = 1
`);

const insertYouTubeSession = db.prepare(`
  INSERT INTO youtube_sessions(id, label, started_at, ended_at)
  VALUES (?, ?, ?, NULL)
`);

const activateYouTubeCapture = db.prepare(`
  UPDATE youtube_capture
  SET session_id = ?, label = ?, started_at = ?
  WHERE id = 1
`);

const finishYouTubeSession = db.prepare(`
  UPDATE youtube_sessions
  SET ended_at = ?
  WHERE id = ?
`);

const clearYouTubeCapture = db.prepare(`
  UPDATE youtube_capture
  SET session_id = NULL, label = NULL, started_at = NULL
  WHERE id = 1
`);

const bumpYouTubeEvent = db.prepare(`
  INSERT INTO youtube_events(
    session_id,
    domain,
    total,
    allowed,
    blocked,
    first_seen_at,
    last_seen_at
  )
  VALUES (?, ?, 1, ?, ?, ?, ?)
  ON CONFLICT(session_id, domain) DO UPDATE SET
    total = total + 1,
    allowed = allowed + excluded.allowed,
    blocked = blocked + excluded.blocked,
    last_seen_at = excluded.last_seen_at
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
  const now = new Date().toISOString();

  try {
    db.exec("BEGIN IMMEDIATE");
    bumpStats.run(allowed, blocked);
    bumpDomain.run(domain, key, allowed, blocked);

    const capture = readActiveYouTubeCapture.get() as {
      session_id?: string | null;
    } | undefined;

    if (capture?.session_id) {
      bumpYouTubeEvent.run(
        capture.session_id,
        domain,
        allowed,
        blocked,
        now,
        now,
      );
    }

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


function normalizeYouTubeLabel(value: string): YouTubeCaptureLabel {
  if (value === "ad" || value === "video") return value;
  throw new Error("youtube capture label must be ad or video");
}

export async function getYouTubeCaptureStatus() {
  const row = readActiveYouTubeCapture.get() as {
    session_id?: string | null;
    label?: string | null;
    started_at?: string | null;
  } | undefined;

  if (!row?.session_id || !row.label || !row.started_at) {
    return { active: false as const };
  }

  return {
    active: true as const,
    sessionId: row.session_id,
    label: normalizeYouTubeLabel(row.label),
    startedAt: row.started_at,
  };
}

export async function startYouTubeCapture(labelValue: string) {
  const label = normalizeYouTubeLabel(labelValue);
  const sessionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  try {
    db.exec("BEGIN IMMEDIATE");

    const active = readActiveYouTubeCapture.get() as {
      session_id?: string | null;
      label?: string | null;
    } | undefined;

    if (active?.session_id) {
      throw new Error(
        `youtube capture already active (${active.label ?? "unknown"})`,
      );
    }

    insertYouTubeSession.run(sessionId, label, startedAt);
    activateYouTubeCapture.run(sessionId, label, startedAt);
    db.exec("COMMIT");

    return { sessionId, label, startedAt };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export async function stopYouTubeCapture() {
  const endedAt = new Date().toISOString();

  try {
    db.exec("BEGIN IMMEDIATE");

    const active = readActiveYouTubeCapture.get() as {
      session_id?: string | null;
      label?: string | null;
      started_at?: string | null;
    } | undefined;

    if (!active?.session_id || !active.label || !active.started_at) {
      throw new Error("no youtube capture is active");
    }

    finishYouTubeSession.run(endedAt, active.session_id);
    clearYouTubeCapture.run();
    db.exec("COMMIT");

    const row = db.prepare(`
      SELECT COUNT(*) AS domains, COALESCE(SUM(total), 0) AS queries
      FROM youtube_events
      WHERE session_id = ?
    `).get(active.session_id) as {
      domains?: number;
      queries?: number;
    } | undefined;

    return {
      sessionId: active.session_id,
      label: normalizeYouTubeLabel(active.label),
      startedAt: active.started_at,
      endedAt,
      domains: toNumber(row?.domains),
      queries: toNumber(row?.queries),
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function compareYouTubeDomains(
  rows: YouTubeDomainComparison[],
  limit = 20,
) {
  const normalize = (row: YouTubeDomainComparison) => ({
    domain: row.domain,
    adCount: toNumber(row.adCount),
    videoCount: toNumber(row.videoCount),
    adSessions: toNumber(row.adSessions),
    videoSessions: toNumber(row.videoSessions),
  });

  const normalized = rows.map(normalize);

  const adOnly = normalized
    .filter(row => row.adCount > 0 && row.videoCount === 0)
    .sort((a, b) => b.adSessions - a.adSessions || b.adCount - a.adCount || a.domain.localeCompare(b.domain))
    .slice(0, limit);

  const videoOnly = normalized
    .filter(row => row.videoCount > 0 && row.adCount === 0)
    .sort((a, b) => b.videoSessions - a.videoSessions || b.videoCount - a.videoCount || a.domain.localeCompare(b.domain))
    .slice(0, limit);

  const shared = normalized
    .filter(row => row.adCount > 0 && row.videoCount > 0)
    .sort((a, b) => (b.adCount + b.videoCount) - (a.adCount + a.videoCount) || a.domain.localeCompare(b.domain))
    .slice(0, limit);

  return { adOnly, videoOnly, shared };
}

export async function getYouTubeReport(limit = 20) {
  const sessionRows = db.prepare(`
    SELECT
      label,
      COUNT(*) AS sessions,
      COALESCE(
        SUM((julianday(ended_at) - julianday(started_at)) * 86400.0),
        0
      ) AS duration_sec
    FROM youtube_sessions
    WHERE ended_at IS NOT NULL
    GROUP BY label
  `).all() as Array<{
    label: string;
    sessions: number;
    duration_sec: number;
  }>;

  const domainRows = db.prepare(`
    SELECT
      e.domain AS domain,
      SUM(CASE WHEN s.label = 'ad' THEN e.total ELSE 0 END) AS adCount,
      SUM(CASE WHEN s.label = 'video' THEN e.total ELSE 0 END) AS videoCount,
      COUNT(DISTINCT CASE WHEN s.label = 'ad' THEN s.id END) AS adSessions,
      COUNT(DISTINCT CASE WHEN s.label = 'video' THEN s.id END) AS videoSessions
    FROM youtube_events e
    JOIN youtube_sessions s ON s.id = e.session_id
    WHERE s.ended_at IS NOT NULL
    GROUP BY e.domain
  `).all() as YouTubeDomainComparison[];

  const sessionStats = {
    ad: { sessions: 0, durationSec: 0 },
    video: { sessions: 0, durationSec: 0 },
  };

  for (const row of sessionRows) {
    if (row.label !== "ad" && row.label !== "video") continue;
    sessionStats[row.label] = {
      sessions: toNumber(row.sessions),
      durationSec: Number(toNumber(row.duration_sec).toFixed(1)),
    };
  }

  return {
    ...sessionStats,
    ...compareYouTubeDomains(domainRows, limit),
  };
}
