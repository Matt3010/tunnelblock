export type LanPort = {
  protocol: "tcp" | "udp";
  port: number;
  service: string | null;
};

export type LanHost = {
  ip: string;
  hostname: string | null;
  mac: string | null;
  vendor: string | null;
  self: boolean;
  ports: LanPort[];
};

export type LanInventory = {
  scannedAt: string;
  interface: string | null;
  target: string | null;
  hosts: LanHost[];
};

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseIpv4(value: string): number[] | null {
  const match = ipv4Pattern.exec(value);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every(octet => octet <= 255) ? octets : null;
}

// Must match WG_LAN_RANGES in vpn/wireguard/lan-acl.sh.
export function isPrivateIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

// Rule tokens: IP/any, IP/tcp/PORT, IP/udp/PORT (see peer-manager.sh lan-set).
export function validLanRule(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^([\d.]+)\/(any|(tcp|udp)\/(\d{1,5}))$/.exec(value);
  if (!match || !isPrivateIpv4(match[1])) return false;
  if (match[2] === "any") return true;
  const port = Number(match[4]);
  return port >= 1 && port <= 65535;
}

function xmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  if (!match) return null;
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function compareIpv4(a: string, b: string): number {
  const left = parseIpv4(a) ?? [];
  const right = parseIpv4(b) ?? [];
  for (let index = 0; index < 4; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export function parseDiscoveryOutput(output: string, scannedAt = new Date().toISOString()): LanInventory {
  const header = /^# tunnelblock-discovery (.*)$/m.exec(output)?.[1] ?? "";
  const meta = Object.fromEntries(
    header.split(/\s+/).filter(Boolean).map(pair => {
      const index = pair.indexOf("=");
      return [pair.slice(0, index), pair.slice(index + 1)];
    }),
  ) as Record<string, string>;

  const hosts: LanHost[] = [];
  for (const [, body] of output.matchAll(/<host[\s>]([\s\S]*?)<\/host>/g)) {
    const state = /<status\s[^>]*>/.exec(body)?.[0];
    if (state && xmlAttribute(state, "state") !== "up") continue;

    let ip: string | null = null;
    let mac: string | null = null;
    let vendor: string | null = null;
    for (const [tag] of body.matchAll(/<address\s[^>]*>/g)) {
      const type = xmlAttribute(tag, "addrtype");
      if (type === "ipv4") ip = xmlAttribute(tag, "addr");
      if (type === "mac") {
        mac = xmlAttribute(tag, "addr");
        vendor = xmlAttribute(tag, "vendor");
      }
    }
    if (!ip || !isPrivateIpv4(ip)) continue;

    const hostnameTag = /<hostname\s[^>]*>/.exec(body)?.[0];
    const ports: LanPort[] = [];
    for (const [, attributes, portBody] of body.matchAll(/<port\s([^>]*)>([\s\S]*?)<\/port>/g)) {
      const portTag = ` ${attributes}`;
      const protocol = xmlAttribute(portTag, "protocol");
      const port = Number(xmlAttribute(portTag, "portid"));
      const stateTag = /<state\s[^>]*>/.exec(portBody)?.[0];
      if (!stateTag || xmlAttribute(stateTag, "state") !== "open") continue;
      if ((protocol !== "tcp" && protocol !== "udp") || !Number.isInteger(port)) continue;
      const serviceTag = /<service\s[^>]*>/.exec(portBody)?.[0];
      ports.push({ protocol, port, service: serviceTag ? xmlAttribute(serviceTag, "name") : null });
    }
    ports.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));

    hosts.push({
      ip,
      hostname: hostnameTag ? xmlAttribute(hostnameTag, "name") : null,
      mac,
      vendor,
      self: ip === meta.self,
      ports,
    });
  }
  hosts.sort((a, b) => compareIpv4(a.ip, b.ip));

  return {
    scannedAt,
    interface: meta.interface ?? null,
    target: meta.target ?? null,
    hosts,
  };
}
