import crypto from "node:crypto";
import dgram from "node:dgram";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { parseQuestion, buildBlockedResponse } from "./dns.js";
import { RuleEngine } from "./rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
});

app.addContentTypeParser(
  "application/dns-message",
  { parseAs: "buffer" },
  (_request, body, done) => done(null, body),
);

const rules = RuleEngine.fromFiles(
  path.join(root, "rules/block.txt"),
  path.join(root, "rules/allow.txt"),
);

const upstreamHost = process.env.UPSTREAM_DNS_HOST ?? "1.1.1.1";
const upstreamPort = Number(process.env.UPSTREAM_DNS_PORT ?? 53);
const publicDoHUrl =
  process.env.PUBLIC_DOH_URL ??
  "https://adblock.scanferlamatteo.work/dns-query";

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

  app.log.info({
    qname: question.qname,
    qtype: question.qtype,
    decision,
    bytes: packet.length,
  }, "dns-query");

  if (decision === "block") {
    return buildBlockedResponse(packet);
  }

  return forwardUdp(packet);
}

app.get("/health", async () => ({ ok: true }));

app.get("/install", async (_request, reply) => {
  return reply
    .header("content-type", "application/x-apple-aspen-config")
    .header(
      "content-disposition",
      'attachment; filename="adblock-general-purpose.mobileconfig"',
    )
    .header("cache-control", "no-store")
    .send(buildMobileconfig());
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
