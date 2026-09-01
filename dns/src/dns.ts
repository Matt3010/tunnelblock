export type DnsQuestion = {
  id: number;
  flags: number;
  qname: string;
  qtype: number;
  qclass: number;
  questionEnd: number;
};

function readName(packet: Buffer, start: number): { name: string; end: number } {
  const labels: string[] = [];
  const visited = new Set<number>();
  let offset = start;
  let end: number | undefined;
  let expandedLength = 0;

  while (true) {
    if (offset >= packet.length) throw new Error("Invalid DNS name");
    if (visited.has(offset)) throw new Error("DNS compression pointer loop");
    visited.add(offset);

    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error("Truncated DNS compression pointer");
      const pointer = ((length & 0x3f) << 8) | packet[offset + 1];
      if (pointer >= packet.length) throw new Error("Invalid DNS compression pointer");
      end ??= offset + 2;
      offset = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0) throw new Error("Invalid DNS label type");

    offset += 1;
    if (length === 0) {
      end ??= offset;
      break;
    }
    if (length > 63 || offset + length > packet.length) {
      throw new Error("Invalid DNS label length");
    }
    expandedLength += length + (labels.length ? 1 : 0);
    if (expandedLength > 253) throw new Error("DNS name is too long");
    labels.push(packet.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }

  return { name: labels.join(".").toLowerCase(), end };
}

export function parseQuestion(packet: Buffer): DnsQuestion {
  if (packet.length < 12) throw new Error("DNS packet too short");

  const id = packet.readUInt16BE(0);
  const flags = packet.readUInt16BE(2);
  const qdcount = packet.readUInt16BE(4);
  if (qdcount < 1) throw new Error("DNS packet has no question");

  const name = readName(packet, 12);
  const offset = name.end;

  if (offset + 4 > packet.length) throw new Error("Incomplete DNS question");

  const qtype = packet.readUInt16BE(offset);
  const qclass = packet.readUInt16BE(offset + 2);
  const questionEnd = offset + 4;

  return {
    id,
    flags,
    qname: name.name,
    qtype,
    qclass,
    questionEnd,
  };
}

export function buildErrorResponse(packet: Buffer, rcode: number): Buffer {
  if (rcode < 0 || rcode > 15) throw new Error("invalid DNS response code");
  const question = parseQuestion(packet);
  const header = Buffer.alloc(12);
  const rd = question.flags & 0x0100;
  header.writeUInt16BE(question.id, 0);
  header.writeUInt16BE(0x8000 | 0x0080 | rd | rcode, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, packet.subarray(12, question.questionEnd)]);
}

export function buildBlockedResponse(packet: Buffer): Buffer {
  const question = parseQuestion(packet);
  const header = Buffer.alloc(12);

  header.writeUInt16BE(question.id, 0);
  // QR=1, copy RD, RA=1, NOERROR
  const rd = question.flags & 0x0100;
  header.writeUInt16BE(0x8000 | 0x0080 | rd, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  return Buffer.concat([header, packet.subarray(12, question.questionEnd)]);
}
