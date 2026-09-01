import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import { decodeTcpDnsFrames, encodeTcpDnsFrame } from "./raw-dns.js";

export type UpstreamFamily = "auto" | "4" | "6";

export type UpstreamOptions = {
  host: string;
  port: number;
  family?: UpstreamFamily;
  timeoutMs?: number;
};

type Endpoint = { address: string; family: 4 | 6 };

export function literalEndpoint(host: string): Endpoint | null {
  const family = net.isIP(host);
  return family === 4 || family === 6 ? { address: host, family } : null;
}

async function endpoint(options: UpstreamOptions): Promise<Endpoint> {
  const literal = literalEndpoint(options.host);
  if (literal) {
    if (options.family && options.family !== "auto" && Number(options.family) !== literal.family) {
      throw new Error("upstream DNS family does not match address");
    }
    return literal;
  }
  const family = options.family === "4" ? 4 : options.family === "6" ? 6 : 0;
  const result = await dns.promises.lookup(options.host, { family });
  return { address: result.address, family: result.family as 4 | 6 };
}

function validateResponse(query: Buffer, response: Buffer): Buffer {
  if (query.length < 2 || response.length < 12) throw new Error("invalid upstream DNS response");
  if (response.readUInt16BE(0) !== query.readUInt16BE(0)) {
    throw new Error("upstream DNS transaction ID mismatch");
  }
  return response;
}

async function queryUdp(packet: Buffer, target: Endpoint, options: UpstreamOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(target.family === 6 ? "udp6" : "udp4");
    let settled = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("upstream DNS UDP timeout"));
    }, options.timeoutMs ?? 3000);
    const finish = (error?: Error, response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error); else resolve(validateResponse(packet, response!));
    };
    socket.once("error", error => finish(error));
    socket.connect(options.port, target.address, () => {
      socket.once("message", message => finish(undefined, message));
      socket.send(packet, error => { if (error) finish(error); });
    });
  });
}

async function queryTcp(packet: Buffer, target: Endpoint, options: UpstreamOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: target.address,
      port: options.port,
      family: target.family,
    });
    let pending: Buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => socket.destroy(new Error("upstream DNS TCP timeout")), options.timeoutMs ?? 3000);
    const fail = (error: Error) => {
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.once("connect", () => socket.write(encodeTcpDnsFrame(packet)));
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      const decoded = decodeTcpDnsFrames(pending);
      pending = decoded.remainder;
      if (decoded.messages.length) {
        clearTimeout(timeout);
        socket.destroy();
        try { resolve(validateResponse(packet, decoded.messages[0])); } catch (error) { reject(error); }
      }
    });
  });
}

export async function forwardDnsQuery(packet: Buffer, options: UpstreamOptions): Promise<Buffer> {
  const target = await endpoint(options);
  const udpResponse = await queryUdp(packet, target, options);
  const truncated = (udpResponse.readUInt16BE(2) & 0x0200) !== 0;
  return truncated ? queryTcp(packet, target, options) : udpResponse;
}
