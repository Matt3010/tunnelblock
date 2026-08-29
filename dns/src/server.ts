import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { parseQuestion, buildBlockedResponse } from "./dns.js";
import { RuleEngine } from "./rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const blockPath = path.join(root, "rules/block.txt");
const allowPath = path.join(root, "rules/allow.txt");

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
});

app.addContentTypeParser(
  "application/dns-message",
  { parseAs: "buffer" },
  (_request, body, done) => done(null, body),
);

let rules = RuleEngine.fromFiles(blockPath, allowPath);

const upstreamHost = process.env.UPSTREAM_DNS_HOST ?? "1.1.1.1";
const upstreamPort = Number(process.env.UPSTREAM_DNS_PORT ?? 53);
const publicDoHUrl =
  process.env.PUBLIC_DOH_URL ??
  "https://adblock.scanferlamatteo.work/dns-query";
const adminToken = process.env.ADMIN_API_TOKEN;

const startedAt = Date.now();
let queryCount = 0;
let blockedCount = 0;
let allowedCount = 0;
const blockedDomains = new Map<string, number>();
const allowedDomains = new Map<string, number>();

function bump(map: Map<string, number>, domain: string) {
  map.set(domain, (map.get(domain) ?? 0) + 1);
}

function blockRate(): number {
  return queryCount === 0 ? 0 : Number(((blockedCount / queryCount) * 100).toFixed(2));
}

function top(map: Map<string, number>, limit = 10) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain, count]) => ({ domain, count }));
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
  rules = RuleEngine.fromFiles(blockPath, allowPath);
}

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
  const decision = rules.decide(question.qname);

  queryCount++;
  if (decision === "block") {
    blockedCount++;
    bump(blockedDomains, question.qname);
  } else {
    allowedCount++;
    bump(allowedDomains, question.qname);
  }

  app.log.info({
    qname: question.qname,
    qtype: question.qtype,
    decision,
    bytes: packet.length,
  }, "dns-query");

  if (decision === "block") return buildBlockedResponse(packet);
  return forwardUdp(packet);
}

app.get("/health", async () => ({ ok: true }));

app.get("/install", async (_request, reply) => {
  return reply
    .header("content-type", "application/x-apple-aspen-config")
    .header("content-disposition", 'attachment; filename="adblock-general-purpose.mobileconfig"')
    .header("cache-control", "no-store")
    .send(buildMobileconfig());
});

app.get("/admin/status", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return {
    ok: true,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    queries: queryCount,
    allowed: allowedCount,
    blocked: blockedCount,
    blockRate: blockRate(),
  };
});

app.get("/admin/stats", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return {
    queries: queryCount,
    allowed: allowedCount,
    blocked: blockedCount,
    blockRate: blockRate(),
  };
});

app.get("/admin/top", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const decision = (request.query as { decision?: string }).decision;
  if (decision !== "allow" && decision !== "block") {
    return reply.code(400).send({ error: "decision must be allow or block" });
  }
  return { items: top(decision === "block" ? blockedDomains : allowedDomains) };
});

app.post("/admin/reload", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  reloadRules();
  return { ok: true };
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
        break;
      case "unblock":
        removeRule(blockPath, domain);
        break;
      case "unallow":
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
