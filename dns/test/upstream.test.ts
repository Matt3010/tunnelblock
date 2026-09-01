import dgram from "node:dgram";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { decodeTcpDnsFrames, encodeTcpDnsFrame } from "../src/raw-dns.js";
import { forwardDnsQuery, literalEndpoint } from "../src/upstream.js";

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no address"));
      resolve(address.port);
    });
  });
}

describe("DNS upstream transport", () => {
  it("recognizes IPv4 and IPv6 literal upstreams", () => {
    expect(literalEndpoint("1.1.1.1")?.family).toBe(4);
    expect(literalEndpoint("2606:4700:4700::1111")?.family).toBe(6);
  });

  it("falls back to TCP when the UDP response is truncated", async () => {
    const query = Buffer.alloc(12);
    query.writeUInt16BE(0x4242, 0);
    const full = Buffer.from(query);
    full.writeUInt16BE(0x8180, 2);

    const tcp = net.createServer(socket => {
      let pending = Buffer.alloc(0);
      socket.on("data", chunk => {
        pending = Buffer.concat([pending, chunk]);
        const decoded = decodeTcpDnsFrames(pending);
        if (decoded.messages.length) socket.end(encodeTcpDnsFrame(full));
      });
    });
    const port = await listen(tcp);
    const udp = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(port, "127.0.0.1", () => resolve());
    });
    udp.on("message", (_message, remote) => {
      const truncated = Buffer.from(query);
      truncated.writeUInt16BE(0x8380, 2);
      udp.send(truncated, remote.port, remote.address);
    });

    try {
      const response = await forwardDnsQuery(query, {
        host: "127.0.0.1",
        port,
        timeoutMs: 1000,
      });
      expect(response.readUInt16BE(2) & 0x0200).toBe(0);
      expect(response).toEqual(full);
    } finally {
      udp.close();
      await new Promise<void>(resolve => tcp.close(() => resolve()));
    }
  });
});
