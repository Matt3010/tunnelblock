export type DnsQuestion = {
  id: number;
  flags: number;
  qname: string;
  qtype: number;
  qclass: number;
  questionEnd: number;
};

export function parseQuestion(packet: Buffer): DnsQuestion {
  if (packet.length < 12) throw new Error("DNS packet too short");

  const id = packet.readUInt16BE(0);
  const flags = packet.readUInt16BE(2);
  const qdcount = packet.readUInt16BE(4);
  if (qdcount < 1) throw new Error("DNS packet has no question");

  let offset = 12;
  const labels: string[] = [];

  while (true) {
    const len = packet[offset];
    if (len === undefined) throw new Error("Invalid DNS label");
    offset += 1;
    if (len === 0) break;
    if ((len & 0xc0) !== 0) throw new Error("Compressed QNAME not supported");
    if (offset + len > packet.length) throw new Error("Invalid DNS label length");
    labels.push(packet.subarray(offset, offset + len).toString("utf8"));
    offset += len;
  }

  if (offset + 4 > packet.length) throw new Error("Incomplete DNS question");

  const qtype = packet.readUInt16BE(offset);
  const qclass = packet.readUInt16BE(offset + 2);
  const questionEnd = offset + 4;

  return {
    id,
    flags,
    qname: labels.join(".").toLowerCase(),
    qtype,
    qclass,
    questionEnd,
  };
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
