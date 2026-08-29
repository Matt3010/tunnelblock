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
});
