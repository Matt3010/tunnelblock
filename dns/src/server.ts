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

const rules = RuleEngine.fromFiles(
  path.join(root, "rules/block.txt"),
  path.join(root, "rules/allow.txt"),
);

const upstreamHost = process.env.UPSTREAM_DNS_HOST ?? "1.1.1.1";
const upstreamPort = Number(process.env.UPSTREAM_DNS_PORT ?? 53);

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
  }, "dns-query");

  if (decision === "block") {
    return buildBlockedResponse(packet);
  }

  return forwardUdp(packet);
}

app.get("/health", async () => ({ ok: true }));

app.route({
  method: ["GET", "POST"],
  url: "/dns-query",
  handler: async (request, reply) => {
    let packet: Buffer;

    if (request.method === "GET") {
      const dns = (request.query as { dns?: string }).dns;
      if (!dns) return reply.code(400).send("missing dns query parameter");
      packet = Buffer.from(
        dns.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      );
    } else {
      const body = request.body;
      if (Buffer.isBuffer(body)) {
        packet = body;
      } else if (typeof body === "string") {
        packet = Buffer.from(body, "binary");
      } else {
        return reply.code(400).send("invalid dns payload");
      }
    }

    const result = await resolveDns(packet);

    return reply
      .header("content-type", "application/dns-message")
      .send(result);
  }
});

await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8053),
});
