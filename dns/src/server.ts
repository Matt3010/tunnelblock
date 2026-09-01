import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { startRawDnsServer, type RawDnsContext } from "./raw-dns.js";
import { parseQuestion, buildBlockedResponse, buildErrorResponse } from "./dns.js";
import { DnsRateLimiter } from "./rate-limit.js";
import { forwardDnsQuery, type UpstreamFamily } from "./upstream.js";
import { DnsCache } from "./cache.js";
import { RuleEngine } from "./rules.js";
import { BlocklistManager } from "./lists.js";
import {
  getDomains,
  getStats,
  getTop,
  makeDomainKey,
  recordQuery,
  resolveDomainKey,
  statsReady,
  ensureStatsReady,
} from "./stats.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const rulesDir = path.join(root, "rules");
const blockPath = path.join(rulesDir, "block.txt");
const allowPath = path.join(rulesDir, "allow.txt");
const externalBlockPath = path.join(rulesDir, "external-block.txt");

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
});

const blocklists = new BlocklistManager(rulesDir, externalBlockPath);
let rules = RuleEngine.fromFiles(blockPath, allowPath, externalBlockPath);

const upstreamHost = process.env.UPSTREAM_DNS_HOST ?? "1.1.1.1";
const upstreamPort = Number(process.env.UPSTREAM_DNS_PORT ?? 53);
const upstreamFamily = (process.env.UPSTREAM_DNS_FAMILY ?? "auto") as UpstreamFamily;
const upstreamTimeoutMs = Number(process.env.UPSTREAM_DNS_TIMEOUT_MS ?? 3000);
const rateLimitQps = Number(process.env.DNS_RATE_LIMIT_QPS ?? 200);
const rateLimitBurst = Number(process.env.DNS_RATE_LIMIT_BURST ?? 400);
const cacheMaxEntries = Number(process.env.DNS_CACHE_MAX_ENTRIES ?? 10000);
const cacheMaxTtlSeconds = Number(process.env.DNS_CACHE_MAX_TTL_SECONDS ?? 3600);
if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
  throw new Error("invalid UPSTREAM_DNS_PORT");
}
if (!["auto", "4", "6"].includes(upstreamFamily)) {
  throw new Error("invalid UPSTREAM_DNS_FAMILY");
}
if (!Number.isFinite(upstreamTimeoutMs) || upstreamTimeoutMs < 100) {
  throw new Error("invalid UPSTREAM_DNS_TIMEOUT_MS");
}
const rateLimiter = new DnsRateLimiter(rateLimitQps, rateLimitBurst);
const dnsCache = new DnsCache(cacheMaxEntries, cacheMaxTtlSeconds);
const adminToken = process.env.ADMIN_API_TOKEN;

const startedAt = Date.now();

function activeRules(file: string): Set<string> {
  return new Set(
    readRuleLines(file)
      .map(line => line.trim().toLowerCase())
      .filter(line => line && !line.startsWith("#")),
  );
}

function describeDomain(domain: string) {
  const detail = rules.explain(domain);
  const blocklistMatches = blocklists.findMatches(domain);
  const primaryBlocklist = blocklistMatches[0] ?? null;

  const state: "allow" | "block" | "list" | "default" =
    detail.source === "manual-allow" ? "allow" :
    detail.source === "manual-block" ? "block" :
    detail.source === "external-block" ? "list" :
    "default";

  return {
    state,
    decision: detail.decision,
    source: detail.source,
    matchedRule: detail.matchedRule,
    blocklist: primaryBlocklist
      ? {
          id: primaryBlocklist.source.id,
          url: primaryBlocklist.source.url,
          matchedRule: primaryBlocklist.matchedRule,
        }
      : null,
    blocklists: blocklistMatches.map(match => ({
      id: match.source.id,
      url: match.source.url,
      matchedRule: match.matchedRule,
    })),
  };
}

async function domainItems(limit = 8, offset = 0) {
  const result = await getDomains(limit, offset);
  return {
    total: result.total,
    items: result.items.map(item => ({
      ...item,
      ...describeDomain(item.domain),
    })),
  };
}

async function resolveObservedDomain(key: string): Promise<string | undefined> {
  const observed = await resolveDomainKey(key);
  if (observed) return observed;

  const ruleDomains = new Set<string>([
    ...activeRules(allowPath),
    ...activeRules(blockPath),
  ]);

  return [...ruleDomains].find(domain => makeDomainKey(domain) === key);
}

function requireAdmin(request: any, reply: any): boolean {
  if (!adminToken) {
    reply.code(503).send({ error: "ADMIN_API_TOKEN not configured" });
    return false;
  }
  if (request.headers.authorization !== `Bearer ${adminToken}`) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

function normalizeDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
    throw new Error("invalid domain");
  }
  return domain;
}

function readRuleLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

function writeRuleLines(file: string, lines: string[]) {
  const cleaned = lines
    .map(line => line.trim())
    .filter(Boolean);
  fs.writeFileSync(file, cleaned.join("\n") + "\n");
}

function addRule(file: string, domain: string) {
  const lines = readRuleLines(file);
  const active = lines
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.toLowerCase());

  if (!active.includes(domain)) {
    lines.push(domain);
    writeRuleLines(file, lines);
  }
}

function removeRule(file: string, domain: string) {
  const lines = readRuleLines(file).filter(line => line.trim().toLowerCase() !== domain);
  writeRuleLines(file, lines);
}

function reloadRules() {
  rules = RuleEngine.fromFiles(blockPath, allowPath, externalBlockPath);
}

let reloadTimer: NodeJS.Timeout | undefined;
fs.watch(path.dirname(blockPath), (_eventType, filename) => {
  if (filename !== "block.txt" && filename !== "allow.txt" && filename !== "external-block.txt") return;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      reloadRules();
      app.log.info({ filename }, "rules-auto-reloaded");
    } catch (error) {
      app.log.error({ error, filename }, "rules-auto-reload-failed");
    }
  }, 150);
});

async function resolveDns(packet: Buffer, context: RawDnsContext): Promise<Buffer> {
  if (!rateLimiter.allow(context.remoteAddress)) {
    app.log.warn({ ...context }, "dns-rate-limited");
    return buildErrorResponse(packet, 5);
  }
  const question = parseQuestion(packet);
  const detail = rules.explain(question.qname);
  const decision = detail.decision;

  void recordQuery(question.qname, decision);

  const cached = decision === "allow" ? dnsCache.get(packet) : null;
  app.log.info({
    qname: question.qname,
    qtype: question.qtype,
    decision,
    decisionSource: detail.source,
    matchedRule: detail.matchedRule,
    bytes: packet.length,
    cacheHit: cached !== null,
  }, "dns-query");

  if (decision === "block") return buildBlockedResponse(packet);
  if (cached) return cached;
  const response = await forwardDnsQuery(packet, {
    host: upstreamHost,
    port: upstreamPort,
    family: upstreamFamily,
    timeoutMs: upstreamTimeoutMs,
  });
  dnsCache.set(packet, response);
  return response;
}

app.get("/health", async () => ({
  ok: true,
  statsStorage: statsReady() ? "sqlite" : "degraded",
  dnsCacheEntries: dnsCache.size(),
}));

app.get("/ready", async (_request, reply) => {
  const ready = await ensureStatsReady(1500);
  if (!ready) {
    return reply.code(503).send({
      ok: false,
      statsStorage: "unavailable",
    });
  }

  return {
    ok: true,
    statsStorage: "sqlite",
  };
});

app.get("/admin/status", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const stats = await getStats();
    const listDiagnostics = blocklists.diagnostics();
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      statsStorage: "sqlite",
      blocklists: listDiagnostics.activeCount,
      configuredBlocklists: listDiagnostics.configuredCount,
      externalBlockedDomains: listDiagnostics.combinedDomainCount,
      blocklistDuplicateEntries: listDiagnostics.duplicateEntries,
      blocklistErrors: listDiagnostics.unhealthyCount,
      dnsCacheEntries: dnsCache.size(),
      ...stats,
    };
  } catch (error) {
    return reply.code(503).send({
      error: error instanceof Error ? error.message : String(error),
      statsStorage: "unavailable",
    });
  }
});

app.get("/admin/top", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const decision = (request.query as { decision?: string }).decision;
  if (decision !== "allow" && decision !== "block") {
    return reply.code(400).send({ error: "decision must be allow or block" });
  }

  try {
    const items = await getTop(decision);
    return {
      items: items.map(item => ({
        ...item,
        ...describeDomain(item.domain),
      })),
    };
  } catch (error) {
    return reply.code(503).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/admin/domains", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const query = request.query as { limit?: string; offset?: string };
  const requestedLimit = Number(query.limit ?? 8);
  const requestedOffset = Number(query.offset ?? 0);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 20) : 8;
  const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
  try {
    return await domainItems(limit, offset);
  } catch (error) {
    return reply.code(503).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/admin/lists", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return blocklists.diagnostics();
});

app.post("/admin/lists", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const body = request.body as { url?: string };
    const source = await blocklists.add(body?.url ?? "");
    reloadRules();
    return reply.code(201).send({ ok: true, source });
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/admin/lists/refresh", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  const result = await blocklists.refreshAll();
  reloadRules();
  return { ok: result.failed === 0, ...result };
});

app.post("/admin/lists/:id/refresh", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const { id } = request.params as { id: string };
    const source = await blocklists.refresh(id);
    reloadRules();
    return { ok: true, source };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/admin/lists/:id/enabled", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: boolean };
    if (typeof body?.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be boolean" });
    }

    const source = blocklists.setEnabled(id, body.enabled);
    reloadRules();
    return { ok: true, source };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.delete("/admin/lists/:id", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const { id } = request.params as { id: string };
    blocklists.remove(id);
    reloadRules();
    return { ok: true };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/admin/reload", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  reloadRules();
  return { ok: true };
});

app.post("/admin/rules/by-key", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const body = request.body as { action?: string; key?: string };
    const action = body?.action;
    const key = body?.key ?? "";
    const domain = await resolveObservedDomain(key);

    if (!domain) return reply.code(404).send({ error: "domain not found" });

    if (action === "block") {
      addRule(blockPath, domain);
      removeRule(allowPath, domain);
    } else if (action === "allow") {
      addRule(allowPath, domain);
      removeRule(blockPath, domain);
    } else if (action === "default") {
      removeRule(blockPath, domain);
      removeRule(allowPath, domain);
    } else {
      return reply.code(400).send({ error: "invalid action" });
    }

    reloadRules();
    return { ok: true, action, domain, ...describeDomain(domain) };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const httpHost = process.env.HOST ?? "0.0.0.0";
const httpPort = Number(process.env.PORT ?? 8053);

await app.listen({
  host: httpHost,
  port: httpPort,
});

const rawDnsPort = Number(process.env.DNS_PORT ?? 0);
if (rawDnsPort > 0) {
  const rawDnsHost = process.env.DNS_HOST ?? "0.0.0.0";
  await startRawDnsServer({
    host: rawDnsHost,
    port: rawDnsPort,
    resolve: resolveDns,
    logger: app.log,
  });
}
