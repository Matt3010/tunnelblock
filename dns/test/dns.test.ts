import { describe, expect, it } from "vitest";
import { buildBlockedResponse, parseQuestion } from "../src/dns.js";

function queryFor(name: string): Buffer {
  const labels = name.split(".").flatMap(label => {
    const b = Buffer.from(label);
    return [Buffer.from([b.length]), b];
  });

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0);
  tail.writeUInt16BE(1, 2);

  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

describe("dns parser", () => {
  it("parses A questions", () => {
    const q = parseQuestion(queryFor("ads.doubleclick.net"));
    expect(q.qname).toBe("ads.doubleclick.net");
    expect(q.qtype).toBe(1);
  });

  it("builds an empty NOERROR blocked response", () => {
    const res = buildBlockedResponse(queryFor("ads.doubleclick.net"));
    expect(res.readUInt16BE(0)).toBe(0x1234);
    expect(res.readUInt16BE(6)).toBe(0);
  });

  it("parses a compressed QNAME and rejects pointer loops", () => {
    const base = queryFor("ads.example.com");
    const compressed = Buffer.concat([
      base.subarray(0, 12),
      Buffer.from([3]), Buffer.from("www"),
      Buffer.from([0xc0, 0x16]),
      base.subarray(base.length - 4),
      Buffer.from([7]), Buffer.from("example"), Buffer.from([3]), Buffer.from("com"), Buffer.from([0]),
    ]);
    expect(parseQuestion(compressed).qname).toBe("www.example.com");

    const loop = Buffer.concat([
      base.subarray(0, 12), Buffer.from([0xc0, 0x0c]), base.subarray(base.length - 4),
    ]);
    expect(() => parseQuestion(loop)).toThrow(/pointer loop/);
  });
});
