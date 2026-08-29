import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { parseQuestion, buildBlockedResponse } from "./dns.js";
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

app.addContentTypeParser(
  "application/dns-message",
  { parseAs: "buffer" },
  (_request, body, done) => done(null, body),
);

const blocklists = new BlocklistManager(rulesDir, externalBlockPath);
let rules = RuleEngine.fromFiles(blockPath, allowPath, externalBlockPath);

const upstreamHost = process.env.UPSTREAM_DNS_HOST ?? "1.1.1.1";
const upstreamPort = Number(process.env.UPSTREAM_DNS_PORT ?? 53);
const publicDoHUrl =
  process.env.PUBLIC_DOH_URL ??
  "https://adblock.scanferlamatteo.work/dns-query";
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
  const blocklistMatch = blocklists.findMatch(domain);

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
    blocklist: blocklistMatch
      ? {
          id: blocklistMatch.source.id,
          url: blocklistMatch.source.url,
          matchedRule: blocklistMatch.matchedRule,
        }
      : null,
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

function buildMobileconfig(): string {
  const dnsUuid = crypto.randomUUID().toUpperCase();
  const profileUuid = crypto.randomUUID().toUpperCase();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.dnsSettings.managed</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>work.scanferlamatteo.adblock.doh</string>
      <key>PayloadUUID</key>
      <string>${dnsUuid}</string>
      <key>PayloadDisplayName</key>
      <string>AdBlock DNS</string>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key>
        <string>HTTPS</string>
        <key>ServerURL</key>
        <string>${publicDoHUrl}</string>
      </dict>
    </dict>
  </array>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>work.scanferlamatteo.adblock</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadDisplayName</key>
  <string>AdBlock General Purpose</string>
</dict>
</plist>
`;
}

async function forwardUdp(packet: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("upstream DNS timeout"));
    }, 3000);

    socket.once("error", err => {
      clearTimeout(timeout);
      socket.close();
      reject(err);
    });

    socket.once("message", message => {
      clearTimeout(timeout);
      socket.close();
      resolve(message);
    });

    socket.send(packet, upstreamPort, upstreamHost);
  });
}

async function resolveDns(packet: Buffer): Promise<Buffer> {
  const question = parseQuestion(packet);
  const detail = rules.explain(question.qname);
  const decision = detail.decision;

  void recordQuery(question.qname, decision);

  app.log.info({
    qname: question.qname,
    qtype: question.qtype,
    decision,
    decisionSource: detail.source,
    matchedRule: detail.matchedRule,
    bytes: packet.length,
  }, "dns-query");

  if (decision === "block") return buildBlockedResponse(packet);
  return forwardUdp(packet);
}

app.get("/health", async () => ({
  ok: true,
  statsStorage: statsReady() ? "sqlite" : "degraded",
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

app.get("/install", async (_request, reply) => {
  return reply
    .header("content-type", "application/x-apple-aspen-config")
    .header("content-disposition", 'attachment; filename="adblock-general-purpose.mobileconfig"')
    .header("cache-control", "no-store")
    .send(buildMobileconfig());
});

app.get("/admin/status", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const stats = await getStats();
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      statsStorage: "sqlite",
      blocklists: blocklists.activeCount(),
      configuredBlocklists: blocklists.list().length,
      externalBlockedDomains: blocklists.combinedDomainCount(),
      ...stats,
    };
  } catch (error) {
    return reply.code(503).send({
      error: error instanceof Error ? error.message : String(error),
      statsStorage: "unavailable",
    });
  }
});

app.get("/admin/stats", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    return await getStats();
  } catch (error) {
    return reply.code(503).send({
      error: error instanceof Error ? error.message : String(error),
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
    return { items: await getTop(decision) };
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
  return {
    items: blocklists.list(),
    combinedDomainCount: blocklists.combinedDomainCount(),
  };
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

app.post("/admin/rules", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;

  try {
    const body = request.body as { action?: string; domain?: string };
    const action = body?.action;
    const domain = normalizeDomain(body?.domain ?? "");

    switch (action) {
      case "block":
        addRule(blockPath, domain);
        removeRule(allowPath, domain);
        break;
      case "allow":
        addRule(allowPath, domain);
        removeRule(blockPath, domain);
        break;
      case "unblock":
        removeRule(blockPath, domain);
        break;
      case "unallow":
        removeRule(allowPath, domain);
        break;
      case "default":
        removeRule(blockPath, domain);
        removeRule(allowPath, domain);
        break;
      default:
        return reply.code(400).send({ error: "invalid action" });
    }

    reloadRules();
    return { ok: true, action, domain };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.route({
  method: ["GET", "POST"],
  url: "/dns-query",
  handler: async (request, reply) => {
    let packet: Buffer;

    if (request.method === "GET") {
      const dns = (request.query as { dns?: string }).dns;
      if (!dns) return reply.code(400).send("missing dns query parameter");

      const normalized = dns
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(dns.length / 4) * 4, "=");

      packet = Buffer.from(normalized, "base64");
    } else {
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send("expected application/dns-message");
      }
      packet = request.body;
    }

    try {
      const result = await resolveDns(packet);
      return reply
        .header("content-type", "application/dns-message")
        .header("cache-control", "no-store")
        .send(result);
    } catch (error) {
      request.log.error({ error }, "dns-resolution-failed");
      return reply.code(502).send("dns resolution failed");
    }
  }
});

await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8053),
});
