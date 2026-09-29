import { codeHtml, escapeHtml, formatCount, formatDuration } from "./presentation.js";

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
export type LanScan = { running: boolean; error: string | null };

export const LAN_HOSTS_PAGE_SIZE = 8;

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

// Callback data is limited to 64 bytes, so hosts are encoded as 8 hex chars.
export function ipToHex(ip: string): string {
  return (parseIpv4(ip) ?? [0, 0, 0, 0]).map(octet => octet.toString(16).padStart(2, "0")).join("");
}

export function hexToIp(hex: string): string | null {
  if (!/^[0-9a-f]{8}$/.test(hex)) return null;
  return [0, 2, 4, 6].map(index => parseInt(hex.slice(index, index + 2), 16)).join(".");
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
export function lanHosts(acl: LanAcl, inventory: LanInventory | null): (LanHost & { discovered: boolean })[] {
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

export function hostLabel(host: Pick<LanHost, "ip" | "hostname" | "vendor" | "self">): string {
  const name = host.hostname ?? host.vendor ?? "device";
  const trimmed = name.length > 24 ? `${name.slice(0, 23)}…` : name;
  return host.self ? `${trimmed} (server)` : trimmed;
}

export function lanSummary(acl: LanAcl | undefined): string {
  if (!acl || acl.mode === "full") return "🔓 Full LAN";
  if (!acl.rules.length) return "🌐 Internet only";
  const hosts = new Set(acl.rules.map(ruleHost)).size;
  return `🎯 ${formatCount(hosts)} device${hosts === 1 ? "" : "s"} · ${formatCount(acl.rules.length)} rule${acl.rules.length === 1 ? "" : "s"}`;
}

function scanLine(inventory: LanInventory | null, scan: LanScan, now: number): string {
  if (scan.running) return "🔍 <b>Scanning the network…</b>";
  const lines: string[] = [];
  if (inventory) {
    const age = Math.max(0, (now - Date.parse(inventory.scannedAt)) / 1000);
    lines.push(`<b>Network</b>  ${codeHtml(inventory.target ?? "?")} · ${formatCount(inventory.hosts.length)} devices · scanned ${escapeHtml(formatDuration(age))} ago`);
  } else {
    lines.push("<b>Network</b>  not scanned yet");
  }
  if (scan.error) lines.push(`⚠️ Last scan failed: ${escapeHtml(scan.error.slice(0, 200))}`);
  return lines.join("\n");
}

export function lanAccessView(
  name: string,
  acl: LanAcl,
  inventory: LanInventory | null,
  scan: LanScan,
  page = 0,
  now = Date.now(),
) {
  const rows: any[][] = [];
  const text = [
    `🏠 <b>LAN access · ${escapeHtml(name)}</b>`,
    "",
    `<b>Mode</b>     ${lanSummary(acl)}`,
    scanLine(inventory, scan, now),
    "",
  ];

  if (acl.mode === "full") {
    text.push("Every LAN device and port is reachable from this VPN user.");
    rows.push([{ text: "🎯 Restrict to selected devices", callback_data: `lan:m:${name}:none` }]);
  } else {
    const hosts = lanHosts(acl, inventory);
    const pageCount = Math.max(1, Math.ceil(hosts.length / LAN_HOSTS_PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), pageCount - 1);

    text.push(hosts.length
      ? "Internet always works. Tap a device to choose which ports this user can reach."
      : "Internet always works. No LAN devices discovered yet.");

    for (const host of hosts.slice(safePage * LAN_HOSTS_PAGE_SIZE, (safePage + 1) * LAN_HOSTS_PAGE_SIZE)) {
      const access = hostAccess(acl, host.ip);
      const icon = access.all ? "🔓" : access.ports.size ? "✅" : "⬜";
      const detail = access.all ? "all ports" : access.ports.size ? `${access.ports.size}/${host.ports.length} ports` : `${host.ports.length} ports`;
      rows.push([{
        text: `${icon} ${hostLabel(host)} · ${host.ip} · ${detail}${host.discovered ? "" : " · offline"}`,
        callback_data: `lan:h:${name}:${ipToHex(host.ip)}`,
      }]);
    }

    if (pageCount > 1) {
      const nav: any[] = [];
      if (safePage > 0) nav.push({ text: "⬅️", callback_data: `lan:v:${name}:${safePage - 1}` });
      nav.push({ text: `${safePage + 1}/${pageCount}`, callback_data: `lan:v:${name}:${safePage}` });
      if (safePage < pageCount - 1) nav.push({ text: "➡️", callback_data: `lan:v:${name}:${safePage + 1}` });
      rows.push(nav);
    }

    rows.push([{ text: "➕ Manual rule", callback_data: `lan:n:${name}` }]);
    const modes = [{ text: "🔓 Full LAN", callback_data: `lan:m:${name}:full` }];
    if (acl.rules.length) modes.push({ text: "🌐 Internet only", callback_data: `lan:m:${name}:none` });
    rows.push(modes);
  }

  rows.push([{ text: scan.running ? "🔄 Refresh" : "🔍 Rescan network", callback_data: scan.running ? `lan:v:${name}:${page}` : `lan:s:${name}` }]);
  rows.push([{ text: "⬅️ User", callback_data: `vpn:d:${name}` }]);

  return { text: text.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export function lanHostView(name: string, acl: LanAcl, inventory: LanInventory | null, ip: string) {
  const hosts = lanHosts(acl, inventory);
  const index = hosts.findIndex(host => host.ip === ip);
  const host = hosts[index] ?? { ip, hostname: null, vendor: null, ports: [], discovered: false };
  const access = hostAccess(acl, ip);
  const hex = ipToHex(ip);
  const page = Math.max(0, Math.floor(index / LAN_HOSTS_PAGE_SIZE));

  const rows: any[][] = [[{
    text: `${access.all ? "🔓" : "⬜"} All ports (any protocol)`,
    callback_data: `lan:a:${name}:${hex}`,
  }]];
  if (!access.all) {
    for (const port of host.ports) {
      const key = `${port.protocol}/${port.port}`;
      rows.push([{
        text: `${access.ports.has(key) ? "✅" : "⬜"} ${portLabel(port)}`,
        callback_data: `lan:p:${name}:${hex}:${port.protocol === "tcp" ? "t" : "u"}:${port.port}`,
      }]);
    }
  }
  rows.push([{ text: "⬅️ Devices", callback_data: `lan:v:${name}:${page}` }]);

  const meta = [
    host.hostname ? `<b>Name</b>     ${escapeHtml(host.hostname)}` : "",
    host.vendor ? `<b>Vendor</b>   ${escapeHtml(host.vendor)}` : "",
    `<b>Address</b>  ${codeHtml(ip)}${host.discovered ? "" : " · not seen in last scan"}`,
  ].filter(Boolean);

  return {
    text: [
      `🖥 <b>${escapeHtml(hostLabel(host))}</b> · ${escapeHtml(name)}`,
      "",
      ...meta,
      "",
      access.all
        ? "🔓 Every port on this device is reachable."
        : host.ports.length
          ? "Select the ports this user may reach. Ping is allowed for any selected device."
          : "No open ports discovered. Allow all ports or add a manual rule.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

export function lanManualPrompt(name: string) {
  return {
    text: [
      `➕ <b>Manual LAN rule · ${escapeHtml(name)}</b>`,
      "",
      "Send one of:",
      `${codeHtml("192.168.1.50")} — all ports`,
      `${codeHtml("192.168.1.50:8123")} — TCP port`,
      `${codeHtml("192.168.1.50 udp 1900")} — UDP port`,
      "",
      "Only private LAN addresses are accepted.",
    ].join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `lan:v:${name}:0` }]] },
  };
}
