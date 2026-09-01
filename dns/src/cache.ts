type CachedResponse = {
  response: Buffer;
  storedAt: number;
  expiresAt: number;
  ttlFields: TtlField[];
};

type TtlField = { offset: number; original: number; answer: boolean };

function skipName(packet: Buffer, start: number): number {
  let offset = start;
  while (true) {
    if (offset >= packet.length) throw new Error("invalid DNS name");
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error("truncated DNS pointer");
      return offset + 2;
    }
    if ((length & 0xc0) !== 0 || length > 63) throw new Error("invalid DNS label");
    offset += 1;
    if (length === 0) return offset;
    if (offset + length > packet.length) throw new Error("truncated DNS label");
    offset += length;
  }
}

function responseTtls(packet: Buffer): TtlField[] {
  if (packet.length < 12) throw new Error("short DNS response");
  const questions = packet.readUInt16BE(4);
  const answers = packet.readUInt16BE(6);
  const authorities = packet.readUInt16BE(8);
  const additionals = packet.readUInt16BE(10);
  if (answers === 0) return [];

  let offset = 12;
  for (let index = 0; index < questions; index++) {
    offset = skipName(packet, offset);
    if (offset + 4 > packet.length) throw new Error("truncated DNS question");
    offset += 4;
  }

  const fields: TtlField[] = [];
  const records = answers + authorities + additionals;
  for (let index = 0; index < records; index++) {
    offset = skipName(packet, offset);
    if (offset + 10 > packet.length) throw new Error("truncated DNS record");
    const type = packet.readUInt16BE(offset);
    const ttlOffset = offset + 4;
    const ttl = packet.readUInt32BE(ttlOffset);
    const dataLength = packet.readUInt16BE(offset + 8);
    if (type !== 41) fields.push({ offset: ttlOffset, original: ttl, answer: index < answers });
    offset += 10 + dataLength;
    if (offset > packet.length) throw new Error("truncated DNS record data");
  }
  return fields;
}

function cacheKey(packet: Buffer): string {
  if (packet.length < 12) throw new Error("short DNS query");
  const normalized = Buffer.from(packet);
  normalized.writeUInt16BE(0, 0);
  return normalized.toString("base64");
}

export class DnsCache {
  private readonly entries = new Map<string, CachedResponse>();

  constructor(
    private readonly maxEntries: number,
    private readonly maxTtlSeconds: number,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 0 ||
        !Number.isInteger(maxTtlSeconds) || maxTtlSeconds < 1) {
      throw new Error("invalid DNS cache configuration");
    }
  }

  get(query: Buffer, now = Date.now()): Buffer | null {
    if (this.maxEntries === 0) return null;
    const key = cacheKey(query);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }

    const ageSeconds = Math.floor(Math.max(0, now - entry.storedAt) / 1000);
    const response = Buffer.from(entry.response);
    response.writeUInt16BE(query.readUInt16BE(0), 0);
    for (const field of entry.ttlFields) {
      response.writeUInt32BE(Math.max(0, field.original - ageSeconds), field.offset);
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return response;
  }

  set(query: Buffer, response: Buffer, now = Date.now()): boolean {
    if (this.maxEntries === 0 || response.length < 12) return false;
    const flags = response.readUInt16BE(2);
    const rcode = flags & 0x000f;
    const truncated = (flags & 0x0200) !== 0;
    if (rcode !== 0 || truncated) return false;

    try {
      const ttlFields = responseTtls(response);
      const answerTtls = ttlFields.filter(field => field.answer).map(field => field.original);
      if (!answerTtls.length || answerTtls.some(ttl => ttl === 0)) return false;
      const ttl = Math.min(this.maxTtlSeconds, ...answerTtls);
      const key = cacheKey(query);
      this.entries.delete(key);
      this.entries.set(key, {
        response: Buffer.from(response),
        storedAt: now,
        expiresAt: now + ttl * 1000,
        ttlFields,
      });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      return true;
    } catch {
      return false;
    }
  }

  size(): number {
    return this.entries.size;
  }
}
