export type LanAcl = { mode: "full" | "custom"; rules: string[] };
export type LanPort = { protocol: "tcp" | "udp"; port: number; service: string | null };
export type LanHost = {
  ip: string;
  hostname: string | null;
  vendor: string | null;
  self?: boolean;
  ports: LanPort[];
};
export type LanInventory = {
  scannedAt: string;
  interface: string | null;
  target: string | null;
  hosts: LanHost[];
};
export type LanChange =
  | { kind: "mode"; mode: "full" | "none" }
  | { kind: "all"; ip: string }
  | { kind: "port"; ip: string; protocol: "tcp" | "udp"; port: number }
  | { kind: "manual"; text: string };

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(value: string): number[] | null {
  const match = ipv4Pattern.exec(value);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every(octet => octet <= 255) ? octets : null;
}

// Mirrors isPrivateIpv4 in the updater and WG_LAN_RANGES in lan-acl.sh.
export function isPrivateIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
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

function ruleHost(rule: string): string {
  return rule.split("/")[0];
}

/** Inventory hosts plus hosts that only exist in rules (offline or added manually). */
function lanHosts(acl: LanAcl, inventory: LanInventory | null): (LanHost & { discovered: boolean })[] {
  const hosts = new Map<string, LanHost & { discovered: boolean }>();
  for (const host of inventory?.hosts ?? []) hosts.set(host.ip, { ...host, discovered: true });

  for (const rule of acl.mode === "custom" ? acl.rules : []) {
    const [ip, protocol, port] = rule.split("/");
    const host = hosts.get(ip) ?? { ip, hostname: null, vendor: null, ports: [], discovered: false };
    if (protocol !== "any" && !host.ports.some(item => item.protocol === protocol && item.port === Number(port))) {
      host.ports = [...host.ports, { protocol: protocol as "tcp" | "udp", port: Number(port), service: null }]
        .sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
    }
    hosts.set(ip, host);
  }

  return [...hosts.values()].sort((a, b) => compareIpv4(a.ip, b.ip));
}

export function hostAccess(acl: LanAcl, ip: string): { all: boolean; ports: Set<string> } {
  if (acl.mode === "full") return { all: true, ports: new Set() };
  const all = acl.rules.includes(`${ip}/any`);
  const ports = new Set(acl.rules.filter(rule => ruleHost(rule) === ip && !rule.endsWith("/any")).map(rule => rule.slice(ip.length + 1)));
  return { all, ports };
}

export function toggleHostAll(rules: string[], ip: string): string[] {
  const others = rules.filter(rule => ruleHost(rule) !== ip);
  return rules.includes(`${ip}/any`) ? others : [...others, `${ip}/any`];
}

export function togglePort(rules: string[], ip: string, protocol: "tcp" | "udp", port: number): string[] {
  const rule = `${ip}/${protocol}/${port}`;
  return rules.includes(rule) ? rules.filter(item => item !== rule) : [...rules.filter(item => item !== `${ip}/any`), rule];
}

/** Accepts "192.168.1.10", "192.168.1.10:8123", "192.168.1.10 tcp 8123" or "192.168.1.10 udp 1900". */
export function parseManualRule(text: string): string | null {
  const match = /^\s*([\d.]+)(?:\s*[: ]\s*(?:(tcp|udp)\s+)?(\d{1,5})|\s+(tcp|udp)\s*[:/ ]\s*(\d{1,5}))?\s*$/i.exec(text);
  if (!match || !isPrivateIpv4(match[1])) return null;
  const protocol = (match[2] ?? match[4] ?? "tcp").toLowerCase();
  const portText = match[3] ?? match[5];
  if (!portText) return `${match[1]}/any`;
  const port = Number(portText);
  return port >= 1 && port <= 65535 ? `${match[1]}/${protocol}/${port}` : null;
}

/** New ACL for a change requested by the UI, or null when the change is invalid. */
export function applyLanChange(acl: LanAcl, change: LanChange): LanAcl | null {
  if (change.kind === "mode") return change.mode === "full" ? { mode: "full", rules: [] } : { mode: "custom", rules: [] };

  const rules = acl.mode === "full" ? [] : acl.rules;
  if (change.kind === "manual") {
    const rule = parseManualRule(change.text);
    if (!rule) return null;
    const host = ruleHost(rule);
    const kept = rule.endsWith("/any") ? rules.filter(item => ruleHost(item) !== host) : rules;
    return { mode: "custom", rules: [...new Set([...kept, rule])] };
  }

  if (!isPrivateIpv4(change.ip)) return null;
  if (change.kind === "all") return { mode: "custom", rules: toggleHostAll(rules, change.ip) };
  if (!Number.isInteger(change.port) || change.port < 1 || change.port > 65535) return null;
  return { mode: "custom", rules: togglePort(rules, change.ip, change.protocol, change.port) };
}

const wellKnownPorts: Record<number, string> = {
  22: "SSH",
  53: "DNS",
  80: "HTTP",
  139: "NetBIOS",
  443: "HTTPS",
  445: "SMB",
  548: "AFP",
  554: "RTSP",
  631: "Printer (IPP)",
  1883: "MQTT",
  2049: "NFS",
  3389: "Remote Desktop",
  5900: "VNC",
  8006: "Proxmox",
  8096: "Jellyfin",
  8123: "Home Assistant",
  9100: "Printer",
  19999: "Netdata",
  32400: "Plex",
};

export function portLabel(port: LanPort): string {
  const name = wellKnownPorts[port.port] ?? port.service;
  return `${port.port}/${port.protocol}${name ? ` ${name}` : ""}`;
}

function hostLabel(host: Pick<LanHost, "hostname" | "vendor" | "self">): string {
  const name = host.hostname ?? host.vendor ?? "device";
  return host.self ? `${name} (server)` : name;
}

export function lanSummary(acl: LanAcl | undefined): string {
  if (!acl || acl.mode === "full") return "Full LAN";
  if (!acl.rules.length) return "Internet only";
  const hosts = new Set(acl.rules.map(ruleHost)).size;
  return `${hosts} device${hosts === 1 ? "" : "s"} · ${acl.rules.length} rule${acl.rules.length === 1 ? "" : "s"}`;
}

/** Everything the device list needs, so the browser only renders. */
export function lanDevices(acl: LanAcl, inventory: LanInventory | null) {
  return lanHosts(acl, inventory).map(host => {
    const access = hostAccess(acl, host.ip);
    return {
      ip: host.ip,
      label: hostLabel(host),
      hostname: host.hostname,
      vendor: host.vendor,
      discovered: host.discovered,
      all: access.all,
      ports: host.ports.map(port => ({
        protocol: port.protocol,
        port: port.port,
        label: portLabel(port),
        allowed: access.all || access.ports.has(`${port.protocol}/${port.port}`),
      })),
    };
  });
}
