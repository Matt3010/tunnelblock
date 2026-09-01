import { describe, expect, it } from "vitest";
import { DnsCache } from "../src/cache.js";

function query(id: number, name = "example.com"): Buffer {
  const labels = name.split(".").flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const typeClass = Buffer.from([0, 1, 0, 1]);
  return Buffer.concat([header, ...labels, Buffer.from([0]), typeClass]);
}

function answer(request: Buffer, ttl: number): Buffer {
  const header = Buffer.from(request.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 6);
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(1, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(ttl, 6);
  record.writeUInt16BE(4, 10);
  record.set([1, 2, 3, 4], 12);
  return Buffer.concat([header, request.subarray(12), record]);
}

describe("DNS cache", () => {
  it("reuses responses, updates IDs, and ages TTLs", () => {
    const cache = new DnsCache(10, 3600);
    const first = query(1);
    expect(cache.set(first, answer(first, 30), 1000)).toBe(true);

    const cached = cache.get(query(99), 6000)!;
    expect(cached.readUInt16BE(0)).toBe(99);
    expect(cached.readUInt32BE(cached.length - 10)).toBe(25);
  });

  it("expires entries and does not cache zero-TTL answers", () => {
    const cache = new DnsCache(10, 3600);
    const request = query(1);
    expect(cache.set(request, answer(request, 1), 0)).toBe(true);
    expect(cache.get(request, 1000)).toBeNull();
    expect(cache.set(request, answer(request, 0), 0)).toBe(false);
  });

  it("evicts the least recently used entry", () => {
    const cache = new DnsCache(1, 3600);
    const first = query(1, "one.example");
    const second = query(2, "two.example");
    cache.set(first, answer(first, 30), 0);
    cache.set(second, answer(second, 30), 0);
    expect(cache.get(first, 1)).toBeNull();
    expect(cache.get(second, 1)).not.toBeNull();
  });
});
