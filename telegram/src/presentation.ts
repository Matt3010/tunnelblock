export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlTail(value: unknown, maxEscapedLength: number): string {
  const chars = Array.from(String(value ?? ""));
  const escapedTail: string[] = [];
  let length = 0;

  for (let index = chars.length - 1; index >= 0; index--) {
    const escaped = escapeHtml(chars[index]);
    if (length + escaped.length > maxEscapedLength) break;
    escapedTail.push(escaped);
    length += escaped.length;
  }

  return escapedTail.reverse().join("");
}

export function codeHtml(value: unknown): string {
  return `<code>${escapeHtml(value)}</code>`;
}

export function formatCount(value: unknown): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-US").format(number) : "0";
}

export function formatDuration(totalSeconds: unknown): string {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds ?? 0)));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function serviceIcon(state: unknown): string {
  const value = String(state ?? "").toLowerCase();
  if (["healthy", "running", "online", "ready", "success"].includes(value)) return "✅";
  if (["failed", "error", "unhealthy", "offline"].includes(value)) return "❌";
  if (["stopped", "inactive", "idle"].includes(value)) return "⚪";
  if (["starting", "updating", "running-update"].includes(value)) return "🔄";
  return "⚠️";
}

export function stateIcon(state: string): string {
  if (state === "allow") return "✅";
  if (state === "block") return "🚫";
  if (state === "list") return "📚";
  return "⚪";
}

export function domainsListView(data: any) {
  const rows = (data.items ?? []).map((item: any) => ([{
    text: `${stateIcon(item.state)} ${item.domain} · ${formatCount(item.count)}`,
    callback_data: `domains:d:${item.key}:${data.page}`,
  }]));

  const nav: any[] = [];
  if (data.page > 0) nav.push({ text: "⬅️", callback_data: `domains:p:${data.page - 1}` });
  nav.push({ text: `${data.page + 1}/${data.pageCount}`, callback_data: "domains:noop" });
  if (data.page < data.pageCount - 1) nav.push({ text: "➡️", callback_data: `domains:p:${data.page + 1}` });
  rows.push(nav);

  return {
    text: [
      "🌐 <b>Observed Domains</b>",
      "",
      `<b>${formatCount(data.total)}</b> domains · page ${data.page + 1}/${data.pageCount}`,
      "Tap a domain to inspect or change its rule.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

export function domainStateLabel(state: string): string {
  if (state === "allow") return "Manual allow";
  if (state === "block") return "Manual block";
  if (state === "list") return "Blocklist";
  return "Default";
}

export function domainDetailView(item: any, page: number) {
  const lines = [
    `🌐 <b>${escapeHtml(item.domain)}</b>`,
    "",
    `<b>Decision</b>  ${item.decision === "block" ? "🚫 BLOCK" : "✅ ALLOW"}`,
    `<b>Source</b>    ${escapeHtml(domainStateLabel(item.state))}`,
    `<b>Queries</b>   ${formatCount(item.count)}`,
  ];

  if (item.matchedRule) lines.push(`<b>Rule</b>      ${codeHtml(item.matchedRule)}`);

  const matchingLists = Array.isArray(item.blocklists)
    ? item.blocklists
    : item.blocklist
      ? [item.blocklist]
      : [];

  if (matchingLists.length) {
    lines.push("", `📚 <b>Blocklist matches (${matchingLists.length})</b>`);
    for (const match of matchingLists.slice(0, 5)) {
      lines.push(`• ${escapeHtml(shortListName(match.url))} → ${codeHtml(match.matchedRule ?? item.domain)}`);
    }
    if (matchingLists.length > 5) lines.push(`• … ${matchingLists.length - 5} more`);
  }

  return {
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚪ Default", callback_data: `domains:r:default:${item.key}:${page}` },
          { text: "✅ Allow", callback_data: `domains:r:allow:${item.key}:${page}` },
          { text: "🚫 Block", callback_data: `domains:r:block:${item.key}:${page}` },
        ],
        [{ text: "⬅️ Domains", callback_data: `domains:p:${page}` }],
      ],
    },
  };
}

export function shortListName(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    const tail = url.pathname.split("/").filter(Boolean).pop();
    const value = tail ? `${url.hostname}/${tail}` : url.hostname;
    return value.length > 38 ? value.slice(0, 35) + "…" : value;
  } catch {
    return urlValue.slice(0, 38);
  }
}

export function formatListDate(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB");
}

export function listsView(data: any) {
  const items = data.items ?? [];
  const rows = items.map((item: any) => ([{
    text: `${item.lastError ? "⚠️" : item.enabled ? "✅" : "⏸"} ${shortListName(item.url)} · ${formatCount(item.cachedDomainCount ?? item.domainCount)}`,
    callback_data: `lists:d:${item.id}`,
  }]));

  rows.push([
    { text: "➕ Add", callback_data: "lists:add" },
    { text: "🔄 Refresh all", callback_data: "lists:refresh" },
  ]);

  const activeCount = Number(data.activeCount ?? items.filter((item: any) => item.enabled).length);
  const duplicateEntries = Number(data.duplicateEntries ?? 0);
  const unhealthyCount = Number(data.unhealthyCount ?? items.filter((item: any) => item.lastError).length);

  return {
    text: [
      "📚 <b>External Blocklists</b>",
      "",
      `✅ Active: <b>${activeCount}/${items.length}</b>`,
      `🧱 Unique domains: <b>${formatCount(data.combinedDomainCount ?? 0)}</b>`,
      `🔁 Duplicate entries: <b>${formatCount(duplicateEntries)}</b>`,
      `${unhealthyCount ? "⚠️" : "✅"} Errors: <b>${formatCount(unhealthyCount)}</b>`,
      "",
      items.length
        ? "Select a list to inspect coverage and status."
        : "No external blocklists configured. Manual rules remain active.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

export function listDetailView(item: any) {
  const status = item.lastError ? "⚠️ Error" : item.enabled ? "✅ Active" : "⏸ Disabled";
  const coverage = item.enabled
    ? [
        `Cached domains: <b>${formatCount(item.cachedDomainCount ?? item.domainCount)}</b>`,
        `Unique to this list: <b>${formatCount(item.uniqueDomainCount ?? 0)}</b>`,
        `Shared with other lists: <b>${formatCount(item.overlapDomainCount ?? 0)}</b>`,
      ]
    : [
        `Cached domains: <b>${formatCount(item.cachedDomainCount ?? item.domainCount)}</b>`,
        "Active coverage: <b>disabled</b>",
      ];

  return {
    text: [
      `📚 <b>${escapeHtml(shortListName(item.url))}</b>`,
      "",
      `<b>Status</b>  ${status}`,
      `<b>URL</b>     ${codeHtml(item.url)}`,
      "",
      "<b>Coverage</b>",
      ...coverage,
      "",
      `Last update: ${escapeHtml(formatListDate(item.updatedAt))}`,
      item.lastError ? `⚠️ ${escapeHtml(item.lastError)}` : "✅ No errors reported",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: item.enabled ? "⏸ Disable" : "▶️ Enable", callback_data: `lists:e:${item.id}:${item.enabled ? 0 : 1}` },
          { text: "🔄 Refresh", callback_data: `lists:r:${item.id}` },
        ],
        [{ text: "🗑 Remove", callback_data: `lists:c:${item.id}` }],
        [{ text: "⬅️ Blocklists", callback_data: "lists:home" }],
      ],
    },
  };
}

export function topSourceLabel(item: any): string {
  if (item.source === "manual-block") return "🚫 manuale";
  if (item.source === "manual-allow") return "✅ manuale";
  if (item.source === "external-block") {
    const matches = Array.isArray(item.blocklists) ? item.blocklists : [];
    if (!matches.length) return "📚 blocklist";
    const suffix = matches.length > 1 ? ` +${matches.length - 1}` : "";
    return `📚 ${shortListName(matches[0].url)}${suffix}`;
  }
  return "⚪ default";
}

export function integrationRuntimeLabel(item: any, runtime: any): string {
  if (runtime?.active && runtime.integration === item.id) {
    return `🟢 ${String(runtime.mode ?? "active").toUpperCase()}`;
  }
  return "⚪ Inactive";
}

export function integrationsHomeView(data: any) {
  const items = Array.isArray(data.items) ? data.items : [];
  const runtime = data.runtime ?? {};
  const rows = items.map((item: any) => ([{
    text: `${runtime.active && runtime.integration === item.id ? "🟢" : "⚪"} ${item.name}`,
    callback_data: `integrations:d:${item.id}`,
  }]));

  const activeText = runtime.active
    ? `${escapeHtml(runtime.integration)} · ${escapeHtml(String(runtime.mode ?? "").toUpperCase())}`
    : "None";

  return {
    text: [
      "🧩 <b>HTTPS Integrations</b>",
      "",
      `<b>CA</b>       ${runtime.caReady ? "✅ Ready" : "❌ Not prepared"}`,
      `<b>Active</b>   ${activeText}`,
      `<b>Proxy</b>    ${escapeHtml(runtime.proxyState ?? "unknown")}`,
      `<b>HTTPS</b>    ${escapeHtml(runtime.interception ?? "unknown")}`,
      `<b>QUIC</b>     ${escapeHtml(runtime.quic ?? "unknown")}`,
      "",
      items.length ? "Choose an integration to view its actions." : "No integrations registered.",
      "",
      "ℹ️ The CA is only required for explicit HTTPS inspection tests.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

export function integrationDetailView(item: any, runtime: any) {
  const activeHere = Boolean(runtime?.active && runtime.integration === item.id);
  const rows: any[][] = [];

  for (const action of Array.isArray(item.actions) ? item.actions : []) {
    if (action.visibleWhen === "active" && !activeHere) continue;
    if (action.visibleWhen === "inactive" && activeHere) continue;
    rows.push([{ text: action.label, callback_data: `integrations:a:${item.id}:${action.id}` }]);
  }
  rows.push([{ text: "⬅️ Integrations", callback_data: "integrations:home" }]);

  const observation = item.observation ?? {};
  const modifiedAt = observation.modifiedAt
    ? new Date(observation.modifiedAt).toLocaleString("it-IT")
    : "never";

  return {
    text: [
      `🧩 <b>${escapeHtml(item.name)}</b>`,
      integrationRuntimeLabel(item, runtime),
      "",
      escapeHtml(item.description ?? ""),
      "",
      `<b>Strategy</b>  ${escapeHtml(item.status ?? "experimental")}`,
      `<b>CA</b>        ${runtime?.caReady ? "✅ Ready" : "❌ Not prepared"}`,
      `<b>Log</b>       ${formatBytes(Number(observation.bytes ?? 0))}`,
      `<b>Updated</b>   ${escapeHtml(modifiedAt)}`,
      "",
      activeHere
        ? "🟢 HTTPS inspection is active for this device."
        : runtime?.caReady
          ? "ℹ️ Verify that the CA is installed and trusted before starting."
          : "ℹ️ Prepare and install the CA from the Integrations menu first.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

export function httpsSummaryText(name: string, summary: any): string {
  const interpretation = Number(summary.httpRequests) > 0
    ? "✅ HTTPS was readable for at least part of the traffic."
    : summary.likelyCertificatePinning
      ? "⚠️ Result is compatible with certificate pinning or CA rejection."
      : "ℹ️ Not enough data to evaluate TLS inspection.";

  return [
    `📊 <b>${escapeHtml(name)}</b>`,
    "",
    "<b>TLS</b>",
    `• ClientHello: <b>${formatCount(summary.tlsClientHello ?? 0)}</b>`,
    `• Established: <b>${formatCount(summary.tlsEstablished ?? 0)}</b>`,
    `• Failed: <b>${formatCount(summary.tlsFailed ?? 0)}</b>`,
    "",
    "<b>HTTP visibility</b>",
    `• Requests: <b>${formatCount(summary.httpRequests ?? 0)}</b>`,
    `• Responses: <b>${formatCount(summary.httpResponses ?? 0)}</b>`,
    `• HTTPS hosts: <b>${formatCount(summary.uniqueHosts ?? 0)}</b>`,
    "",
    interpretation,
  ].join("\n");
}

export function helpText(): string {
  return [
    "🛡 <b>TunnelBlock</b>",
    "VPN, DNS and privacy control center.",
    "",
    "<b>Monitoring</b>",
    "/status — VPN & DNS overview",
    "/diag — system diagnostics",
    "/topblocked — most blocked domains",
    "/topallowed — most requested domains",
    "",
    "<b>Management</b>",
    "/domains — domain rules",
    "/lists — external blocklists",
    "/vpn — VPN users",
    "/integrations — HTTPS integrations",
    "",
    "<b>System</b>",
    "/reload — reload DNS rules",
    "/update — update TunnelBlock",
    "/update_status — update progress",
    "/help — show this overview",
  ].join("\n");
}

export function statusText(status: any): string {
  const listErrors = Number(status.blocklistErrors ?? 0);
  return [
    "🛡 <b>TunnelBlock Status</b>",
    "",
    "<b>VPN & DNS</b>",
    `• Resolver: ${status.ok ? "✅ Online" : "❌ Offline"}`,
    `• Uptime: <b>${formatDuration(status.uptimeSec)}</b>`,
    "",
    "<b>Traffic</b>",
    `• Queries: <b>${formatCount(status.queries)}</b>`,
    `• Blocked: <b>${formatCount(status.blocked)}</b>`,
    `• Block rate: <b>${escapeHtml(status.blockRate ?? 0)}%</b>`,
    "",
    "<b>Blocklists</b>",
    `• Active: <b>${formatCount(status.blocklists ?? 0)}</b>`,
    `• Unique domains: <b>${formatCount(status.externalBlockedDomains ?? 0)}</b>`,
    `• Duplicates: <b>${formatCount(status.blocklistDuplicateEntries ?? 0)}</b>`,
    `• Errors: ${listErrors ? "⚠️" : "✅"} <b>${formatCount(listErrors)}</b>`,
  ].join("\n");
}

export function diagnosticsText(input: {
  health: string;
  ready: string;
  updaterLine: string;
  serviceLines: string[];
  runtimeLine: string;
}): string {
  return [
    "🩺 <b>Diagnostics</b>",
    "",
    `<b>Resolver</b>  ${input.health}`,
    `<b>Storage</b>   ${input.ready}`,
    `<b>Updater</b>   ${input.updaterLine}`,
    "",
    "<b>Services</b>",
    ...(input.serviceLines.length ? input.serviceLines.map(line => `• ${line}`) : ["• Service details unavailable"]),
    "",
    `<b>Runtime</b>\n${input.runtimeLine}`,
  ].join("\n");
}

export function updateStatusText(state: any): string {
  const value = state.running
    ? "running"
    : state.lastSuccess === true
      ? "success"
      : state.lastSuccess === false
        ? "failed"
        : "idle";
  const icon = value === "running" ? "🔄" : value === "success" ? "✅" : value === "failed" ? "❌" : "⚪";
  const output = typeof state.lastOutput === "string"
    ? escapeHtmlTail(state.lastOutput, 2800)
    : "";

  return [
    `${icon} <b>Update Status</b>`,
    "",
    `<b>State</b>     ${escapeHtml(value)}`,
    `<b>Started</b>   ${escapeHtml(state.lastStartedAt ?? "-")}`,
    `<b>Finished</b>  ${escapeHtml(state.lastFinishedAt ?? "-")}`,
    output ? `\n<b>Latest output</b>\n<pre>${output}</pre>` : "",
  ].filter(Boolean).join("\n");
}

export function fitsTelegramTextLimit(text: string): boolean {
  return text.length <= TELEGRAM_MAX_TEXT_LENGTH;
}
