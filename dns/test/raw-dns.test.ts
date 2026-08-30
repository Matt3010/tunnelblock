import { describe, expect, it } from "vitest";
import { decodeTcpDnsFrames, encodeTcpDnsFrame } from "../src/raw-dns.js";

describe("raw DNS TCP framing", () => {
  it("encodes and decodes multiple DNS messages", () => {
    const first = Buffer.from([0x01, 0x02, 0x03]);
    const second = Buffer.from([0xaa, 0xbb]);

    const combined = Buffer.concat([
      encodeTcpDnsFrame(first),
      encodeTcpDnsFrame(second),
    ]);
    const decoded = decodeTcpDnsFrames(combined);

    expect(decoded.messages).toEqual([first, second]);
    expect(decoded.remainder.length).toBe(0);
  });

  it("keeps an incomplete TCP frame for the next chunk", () => {
    const message = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    const framed = encodeTcpDnsFrame(message);
    const firstChunk = framed.subarray(0, 4);

    const partial = decodeTcpDnsFrames(firstChunk);
    expect(partial.messages).toEqual([]);
    expect(partial.remainder).toEqual(firstChunk);

    const complete = decodeTcpDnsFrames(
      Buffer.concat([partial.remainder, framed.subarray(4)]),
    );
    expect(complete.messages).toEqual([message]);
    expect(complete.remainder.length).toBe(0);
  });

  it("rejects payloads that cannot fit in the DNS-over-TCP length prefix", () => {
    expect(() => encodeTcpDnsFrame(Buffer.alloc(0x10000))).toThrow(
      /exceeds 65535 bytes/,
    );
  });
});
