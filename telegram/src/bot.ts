import TelegramBot from "node-telegram-bot-api";

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminBase = process.env.ADMIN_API_BASE ?? "http://doh:8053";
const updaterBase = process.env.UPDATER_API_BASE ?? "http://updater:8090";
const adminToken = process.env.ADMIN_API_TOKEN;
const botRuntimeGeneration = process.env.BOT_RUNTIME_GENERATION ?? "unknown";
const allowed = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean),
);

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!adminToken) throw new Error("ADMIN_API_TOKEN is required");

const bot = new TelegramBot(token, { polling: true });

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function codeHtml(value: unknown): string {
  return `<code>${escapeHtml(value)}</code>`;
}

function formatCount(value: unknown): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-US").format(number) : "0";
}

function formatDuration(totalSeconds: unknown): string {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds ?? 0)));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function serviceIcon(state: unknown): string {
  const value = String(state ?? "").toLowerCase();
  if (["healthy", "running", "online", "ready", "success"].includes(value)) return "✅";
  if (["failed", "error", "unhealthy", "offline"].includes(value)) return "❌";
  if (["stopped", "inactive", "idle"].includes(value)) return "⚪";
  if (["starting", "updating", "running-update"].includes(value)) return "🔄";
  return "⚠️";
}

async function sendMessage(
  chatId: number,
  text: string,
  options?: TelegramBot.SendMessageOptions,
) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    ...options,
  });
}

await bot.setMyCommands([
  { command: "status", description: "TunnelBlock status" },
  { command: "diag", description: "System diagnostics" },
  { command: "domains", description: "Manage domains" },
  { command: "lists", description: "Manage blocklists" },
  { command: "vpn", description: "Manage VPN users" },
  { command: "integrations", description: "HTTPS integrations" },
  { command: "topblocked", description: "Most blocked domains" },
  { command: "topallowed", description: "Most requested domains" },
  { command: "update", description: "Update TunnelBlock" },
  { command: "update_status", description: "Update progress" },
  { command: "help", description: "Command overview" },
]);

function isAllowed(userId?: number): boolean {
  if (!userId) return false;
  return allowed.has(String(userId));
}

async function requestJson(base: string, path: string, init?: RequestInit) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminToken}`,
          ...(init?.headers ?? {}),
        },
      });

      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch {}

      if (!res.ok) {
        const error = new Error(`Admin API ${res.status}: ${text}`) as Error & { noRetry?: boolean };
        error.noRetry = res.status >= 400 && res.status < 500;
        throw error;
      }

      return body as any;
    } catch (error) {
      lastError = error;
      if ((error as Error & { noRetry?: boolean })?.noRetry) throw error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 750 * attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function api(path: string, init?: RequestInit) {
  return requestJson(adminBase, path, init);
}

async function updaterApi(path: string, init?: RequestInit) {
  return requestJson(updaterBase, path, init);
}


const DOMAINS_PAGE_SIZE = 8;

function stateIcon(state: string): string {
  if (state === "allow") return "✅";
  if (state === "block") return "🚫";
  if (state === "list") return "📚";
  return "⚪";
}

async function getDomainsPage(page: number) {
  const safePage = Math.max(0, Math.floor(page));
  const offset = safePage * DOMAINS_PAGE_SIZE;
  const result = await api(`/admin/domains?limit=${DOMAINS_PAGE_SIZE}&offset=${offset}`);
  const total = Number(result.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / DOMAINS_PAGE_SIZE));
  const normalizedPage = Math.min(safePage, pageCount - 1);

  if (normalizedPage !== safePage) {
    return getDomainsPage(normalizedPage);
  }

  return {
    items: result.items ?? [],
    total,
    page: normalizedPage,
    pageCount,
  };
}

function domainsListView(data: any) {
  const rows = (data.items ?? []).map((item: any) => ([{
    text: `${stateIcon(item.state)} ${item.domain} · ${formatCount(item.count)}`,
    callback_data: `domains:d:${item.key}:${data.page}`,
  }]));

  const nav: any[] = [];
  if (data.page > 0) {
    nav.push({ text: "⬅️", callback_data: `domains:p:${data.page - 1}` });
  }
  nav.push({ text: `${data.page + 1}/${data.pageCount}`, callback_data: "domains:noop" });
  if (data.page < data.pageCount - 1) {
    nav.push({ text: "➡️", callback_data: `domains:p:${data.page + 1}` });
  }
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

function domainStateLabel(state: string): string {
  if (state === "allow") return "Manual allow";
  if (state === "block") return "Manual block";
  if (state === "list") return "Blocklist";
  return "Default";
}

function domainDetailView(item: any, page: number) {
  const lines = [
    `🌐 <b>${escapeHtml(item.domain)}</b>`,
    "",
    `<b>Decision</b>  ${item.decision === "block" ? "🚫 BLOCK" : "✅ ALLOW"}`,
    `<b>Source</b>    ${escapeHtml(domainStateLabel(item.state))}`,
    `<b>Queries</b>   ${formatCount(item.count)}`,
  ];

  if (item.matchedRule) {
    lines.push(`<b>Rule</b>      ${codeHtml(item.matchedRule)}`);
  }

  const matchingLists = Array.isArray(item.blocklists)
    ? item.blocklists
    : item.blocklist
      ? [item.blocklist]
      : [];

  if (matchingLists.length) {
    lines.push("", `📚 <b>Blocklist matches (${matchingLists.length})</b>`);

    for (const match of matchingLists.slice(0, 5)) {
      lines.push(
        `• ${escapeHtml(shortListName(match.url))} → ${codeHtml(match.matchedRule ?? item.domain)}`,
      );
    }

    if (matchingLists.length > 5) {
      lines.push(`• … ${matchingLists.length - 5} more`);
    }
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

async function editDomainsList(chatId: number, messageId: number, page: number) {
  const data = await getDomainsPage(page);
  const view = domainsListView(data);
  await bot.editMessageText(view.text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: view.reply_markup,
  });
}

async function findDomainOnPage(key: string, page: number) {
  const data = await getDomainsPage(page);
  return {
    data,
    item: (data.items ?? []).find((item: any) => item.key === key),
  };
}


const pendingListAdd = new Map<number, number>();
const pendingPeerAdd = new Map<number, number>();

async function vpnView() {
  const peers = await updaterApi("/vpn/peers");
  const rows = peers.map((peer: any) => ([{
    text: `${peer.enabled ? "✅" : "⏸"} ${peer.name} · ${peer.ipv4}`,
    callback_data: `vpn:d:${peer.name}`,
  }]));
  rows.push([{ text: "➕ New user", callback_data: "vpn:add" }]);

  return {
    text: [
      "👥 <b>VPN Users</b>",
      "",
      `<b>${formatCount(peers.length)}</b> configured`,
      peers.length ? "Select a user to view connection details." : "No VPN users configured yet.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

async function editVpnHome(chatId: number, messageId: number) {
  const view = await vpnView();
  await bot.editMessageText(view.text, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: view.reply_markup });
}

function shortListName(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    const tail = url.pathname.split("/").filter(Boolean).pop();
    const value = tail ? `${url.hostname}/${tail}` : url.hostname;
    return value.length > 38 ? value.slice(0, 35) + "…" : value;
  } catch {
    return urlValue.slice(0, 38);
  }
}

function formatListDate(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB");
}

async function getLists() {
  return api("/admin/lists");
}

function listsView(data: any) {
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

function listDetailView(item: any) {
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
      item.lastError
        ? `⚠️ ${escapeHtml(item.lastError)}`
        : "✅ No errors reported",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: item.enabled ? "⏸ Disable" : "▶️ Enable",
            callback_data: `lists:e:${item.id}:${item.enabled ? 0 : 1}`,
          },
          { text: "🔄 Refresh", callback_data: `lists:r:${item.id}` },
        ],
        [{ text: "🗑 Remove", callback_data: `lists:c:${item.id}` }],
        [{ text: "⬅️ Blocklists", callback_data: "lists:home" }],
      ],
    },
  };
}

async function editListsHome(chatId: number, messageId: number) {
  const data = await getLists();
  const view = listsView(data);
  await bot.editMessageText(view.text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: view.reply_markup,
  });
}

async function getListById(id: string) {
  const data = await getLists();
  return (data.items ?? []).find((item: any) => item.id === id);
}

function topSourceLabel(item: any): string {
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function integrationRuntimeLabel(item: any, runtime: any): string {
  if (runtime?.active && runtime.integration === item.id) {
    return `🟢 ${String(runtime.mode ?? "active").toUpperCase()}`;
  }
  return "⚪ Inactive";
}

async function getIntegrations() {
  return updaterApi("/integrations");
}

function integrationsHomeView(data: any) {
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
      items.length
        ? "Choose an integration to view its actions."
        : "No integrations registered.",
      "",
      "ℹ️ The CA is only required for explicit HTTPS inspection tests.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

function integrationDetailView(item: any, runtime: any) {
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
      `${integrationRuntimeLabel(item, runtime)}`,
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

function httpsSummaryText(name: string, summary: any): string {
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

async function editIntegrationsHome(chatId: number, messageId: number) {
  const data = await getIntegrations();
  const view = integrationsHomeView(data);
  await bot.editMessageText(view.text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: view.reply_markup,
  });
}

async function editIntegrationDetail(chatId: number, messageId: number, id: string) {
  const data = await getIntegrations();
  const item = (data.items ?? []).find((candidate: any) => candidate.id === id);
  if (!item) {
    await editIntegrationsHome(chatId, messageId);
    return;
  }
  const view = integrationDetailView(item, data.runtime);
  await bot.editMessageText(view.text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: view.reply_markup,
  });
}


function helpText(): string {
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

bot.on("callback_query", async query => {
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data ?? "";

  if (!chatId || !messageId || !isAllowed(userId)) {
    await bot.answerCallbackQuery(query.id, { text: "Unauthorized." });
    return;
  }

  try {
    if (data === "integrations:home") {
      await editIntegrationsHome(chatId, messageId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const integrationDetail = data.match(/^integrations:d:([a-z0-9_-]{1,24})$/);
    if (integrationDetail) {
      await editIntegrationDetail(chatId, messageId, integrationDetail[1]);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const integrationAction = data.match(/^integrations:a:([a-z0-9_-]{1,24}):([a-z0-9_-]{1,24})$/);
    if (integrationAction) {
      const [, id, action] = integrationAction;
      await bot.answerCallbackQuery(query.id, { text: "Operation in progress…" });
      const result = await updaterApi(`/integrations/${id}/actions/${action}`, {
        method: "POST",
        body: "{}",
      });
      if (result.certificate) {
        const certificate = result.certificate;
        await bot.sendDocument(chatId, Buffer.from(certificate.base64, "base64"), {
          caption: `🛡 <b>TunnelBlock HTTPS CA</b>\n\nSHA-256\n<code>${escapeHtml(certificate.fingerprint256)}</code>\n\n⚠️ Install and trust this certificate only on a dedicated test device. DNS blocking does not require it.`,
          parse_mode: "HTML",
        }, { filename: certificate.filename, contentType: certificate.contentType });
      }
      if (result.summary) {
        const dataNow = await getIntegrations();
        const item = (dataNow.items ?? []).find((candidate: any) => candidate.id === id);
        await sendMessage(chatId, httpsSummaryText(item?.name ?? id, result.summary));
      }
      await editIntegrationDetail(chatId, messageId, id);
      return;
    }

    if (data === "vpn:home") { pendingPeerAdd.delete(chatId); await editVpnHome(chatId, messageId); await bot.answerCallbackQuery(query.id); return; }
    if (data === "vpn:add") { pendingPeerAdd.set(chatId, messageId); await bot.editMessageText("➕ <b>New VPN User</b>\n\nSend a name using letters, numbers, <code>_</code> or <code>-</code>.", { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "vpn:home" }]] } }); await bot.answerCallbackQuery(query.id); return; }
    const vpnDetail = data.match(/^vpn:d:([A-Za-z0-9_-]{1,32})$/);
    if (vpnDetail) {
      const peers = await updaterApi("/vpn/peers");
      const peer = peers.find((p: any) => p.name === vpnDetail[1]);
      if (!peer) {
        await editVpnHome(chatId, messageId);
        return;
      }

      const last = peer.handshake
        ? new Date(peer.handshake * 1000).toLocaleString("en-GB")
        : "Never";

      await bot.editMessageText([
        `👤 <b>${escapeHtml(peer.name)}</b>`,
        "",
        `<b>Status</b>     ${peer.enabled ? "✅ Enabled" : "⏸ Disabled"}`,
        `<b>IPv4</b>       ${codeHtml(peer.ipv4)}`,
        `<b>Handshake</b>  ${escapeHtml(last)}`,
        `<b>Traffic</b>    ↓ ${formatBytes(Number(peer.rx ?? 0))} · ↑ ${formatBytes(Number(peer.tx ?? 0))}`,
      ].join("\n"), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: peer.enabled ? "⏸ Disable" : "▶️ Enable", callback_data: `vpn:e:${peer.name}:${peer.enabled ? 0 : 1}` }],
            [{ text: "📷 Show QR", callback_data: `vpn:g:${peer.name}` }, { text: "📄 Config", callback_data: `vpn:c:${peer.name}` }],
            [{ text: "🔑 Rotate keys", callback_data: `vpn:r:${peer.name}` }, { text: "🗑 Delete", callback_data: `vpn:q:${peer.name}` }],
            [{ text: "⬅️ Users", callback_data: "vpn:home" }],
          ],
        },
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }
    const vpnEnable = data.match(/^vpn:e:([A-Za-z0-9_-]{1,32}):(0|1)$/);
    if (vpnEnable) { await updaterApi(`/vpn/peers/${vpnEnable[1]}/${vpnEnable[2] === "1" ? "enable" : "disable"}`, { method: "POST", body: "{}" }); await editVpnHome(chatId, messageId); await bot.answerCallbackQuery(query.id, { text: "Status updated" }); return; }
    const vpnConfig = data.match(/^vpn:c:([A-Za-z0-9_-]{1,32})$/);
    if (vpnConfig) { const result = await updaterApi(`/vpn/peers/${vpnConfig[1]}/config`); await bot.sendDocument(chatId, Buffer.from(result.config), {}, { filename: `${vpnConfig[1]}.conf`, contentType: "text/plain" }); await bot.answerCallbackQuery(query.id); return; }
    const vpnQr = data.match(/^vpn:g:([A-Za-z0-9_-]{1,32})$/);
    if (vpnQr) { const result = await updaterApi(`/vpn/peers/${vpnQr[1]}/qr`); await bot.sendPhoto(chatId, Buffer.from(result.pngBase64, "base64"), { caption: `📷 <b>WireGuard QR</b>\n${codeHtml(vpnQr[1])}`, parse_mode: "HTML" }, { filename: `${vpnQr[1]}.png`, contentType: "image/png" }); await bot.answerCallbackQuery(query.id); return; }
    const vpnRotate = data.match(/^vpn:r:([A-Za-z0-9_-]{1,32})$/);
    if (vpnRotate) { await updaterApi(`/vpn/peers/${vpnRotate[1]}/rotate`, { method: "POST", body: "{}" }); await bot.answerCallbackQuery(query.id, { text: "Keys rotated: download the new configuration", show_alert: true }); return; }
    const vpnConfirm = data.match(/^vpn:q:([A-Za-z0-9_-]{1,32})$/);
    if (vpnConfirm) { await bot.editMessageText(`🗑 <b>Delete VPN User?</b>\n\nPermanently delete ${codeHtml(vpnConfirm[1])}?\nThis action cannot be undone.`, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🗑 Confirm", callback_data: `vpn:x:${vpnConfirm[1]}` }], [{ text: "Cancel", callback_data: `vpn:d:${vpnConfirm[1]}` }]] } }); await bot.answerCallbackQuery(query.id); return; }
    const vpnDelete = data.match(/^vpn:x:([A-Za-z0-9_-]{1,32})$/);
    if (vpnDelete) { await updaterApi(`/vpn/peers/${vpnDelete[1]}`, { method: "DELETE" }); await editVpnHome(chatId, messageId); await bot.answerCallbackQuery(query.id, { text: "User deleted" }); return; }
    if (data === "lists:home") {
      await editListsHome(chatId, messageId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === "lists:add") {
      pendingListAdd.set(chatId, messageId);
      await bot.editMessageText(
        "➕ <b>Add Blocklist</b>\n\nSend the <b>HTTPS URL</b> of the list.\n\nSupported formats:\n• plain domains\n• hosts files\n• Adblock <code>||domain^</code> syntax",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "❌ Cancel", callback_data: "lists:canceladd" },
            ]],
          },
        },
      );
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === "lists:canceladd") {
      pendingListAdd.delete(chatId);
      await editListsHome(chatId, messageId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === "lists:refresh") {
      await bot.answerCallbackQuery(query.id, { text: "Blocklist refresh started…" });
      const result = await api("/admin/lists/refresh", { method: "POST", body: "{}" });
      await editListsHome(chatId, messageId);
      if (result.failed) {
        await bot.answerCallbackQuery(query.id, {
          text: `Updated: ${result.updated}, failed: ${result.failed}`,
          show_alert: true,
        }).catch(() => {});
      }
      return;
    }

    const listDetailMatch = data.match(/^lists:d:([a-f0-9]{12})$/);
    if (listDetailMatch) {
      const item = await getListById(listDetailMatch[1]);
      if (!item) {
        await bot.answerCallbackQuery(query.id, { text: "Blocklist not found.", show_alert: true });
        await editListsHome(chatId, messageId);
        return;
      }
      const view = listDetailView(item);
      await bot.editMessageText(view.text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: view.reply_markup,
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const listEnableMatch = data.match(/^lists:e:([a-f0-9]{12}):(0|1)$/);
    if (listEnableMatch) {
      const [, id, enabledRaw] = listEnableMatch;
      const result = await api(`/admin/lists/${id}/enabled`, {
        method: "POST",
        body: JSON.stringify({ enabled: enabledRaw === "1" }),
      });
      const view = listDetailView(result.source);
      await bot.editMessageText(view.text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: view.reply_markup,
      });
      await bot.answerCallbackQuery(query.id, {
        text: result.source.enabled ? "Blocklist enabled" : "Blocklist disabled",
      });
      return;
    }

    const listRefreshMatch = data.match(/^lists:r:([a-f0-9]{12})$/);
    if (listRefreshMatch) {
      await bot.answerCallbackQuery(query.id, { text: "Refreshing…" });
      const result = await api(`/admin/lists/${listRefreshMatch[1]}/refresh`, {
        method: "POST",
        body: "{}",
      });
      const view = listDetailView(result.source);
      await bot.editMessageText(view.text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: view.reply_markup,
      });
      return;
    }

    const listConfirmMatch = data.match(/^lists:c:([a-f0-9]{12})$/);
    if (listConfirmMatch) {
      const item = await getListById(listConfirmMatch[1]);
      if (!item) {
        await editListsHome(chatId, messageId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      await bot.editMessageText(
        `🗑 <b>Remove Blocklist?</b>\n\n<b>${escapeHtml(shortListName(item.url))}</b>\n${codeHtml(item.url)}\n\nThis removes the source from active filtering.`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🗑 Yes, remove", callback_data: `lists:x:${item.id}` }],
              [{ text: "⬅️ Cancel", callback_data: `lists:d:${item.id}` }],
            ],
          },
        },
      );
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const listDeleteMatch = data.match(/^lists:x:([a-f0-9]{12})$/);
    if (listDeleteMatch) {
      await api(`/admin/lists/${listDeleteMatch[1]}`, { method: "DELETE" });
      await editListsHome(chatId, messageId);
      await bot.answerCallbackQuery(query.id, { text: "Blocklist removed" });
      return;
    }

    if (data === "domains:noop") {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const pageMatch = data.match(/^domains:p:(\d+)$/);
    if (pageMatch) {
      await editDomainsList(chatId, messageId, Number(pageMatch[1]));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const detailMatch = data.match(/^domains:d:([a-f0-9]{16}):(\d+)$/);
    if (detailMatch) {
      const [, key, pageRaw] = detailMatch;
      const page = Number(pageRaw);
      const { item } = await findDomainOnPage(key, page);

      if (!item) {
        await bot.answerCallbackQuery(query.id, { text: "Domain is no longer present on this page.", show_alert: true });
        await editDomainsList(chatId, messageId, page);
        return;
      }

      const view = domainDetailView(item, page);
      await bot.editMessageText(view.text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: view.reply_markup,
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const ruleMatch = data.match(/^domains:r:(default|allow|block):([a-f0-9]{16}):(\d+)$/);
    if (ruleMatch) {
      const [, action, key, pageRaw] = ruleMatch;
      const page = Number(pageRaw);
      const result = await api("/admin/rules/by-key", {
        method: "POST",
        body: JSON.stringify({ action, key }),
      });

      const { item } = await findDomainOnPage(key, page);
      const updated = item ?? {
        key,
        domain: result.domain,
        count: 0,
        ...result,
      };

      const view = domainDetailView(updated, page);
      await bot.editMessageText(view.text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: view.reply_markup,
      });

      await bot.answerCallbackQuery(query.id, {
        text: action === "allow" ? "Consentito" : action === "block" ? "Bloccato" : "Ripristinato a Default",
      });
      return;
    }

    await bot.answerCallbackQuery(query.id, { text: "Invalid action." });
  } catch (error) {
    await bot.answerCallbackQuery(query.id, {
      text: error instanceof Error ? error.message.slice(0, 180) : "Error",
      show_alert: true,
    });
  }
});

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text ?? "").trim();

  if (!isAllowed(userId)) {
    await sendMessage(chatId, "⛔ <b>Unauthorized</b>\n\nThis bot is restricted to approved users.");
    return;
  }

  try {
    const pendingPeerMessageId = pendingPeerAdd.get(chatId);
    if (pendingPeerMessageId !== undefined && !text.startsWith("/")) {
      const peer = await updaterApi("/vpn/peers", { method: "POST", body: JSON.stringify({ name: text }) });
      pendingPeerAdd.delete(chatId);
      await editVpnHome(chatId, pendingPeerMessageId);
      await sendMessage(chatId, [
        "✅ <b>VPN User Created</b>",
        "",
        `User: ${codeHtml(peer.name ?? text)}`,
        "",
        "<b>Next steps</b>",
        "1. Open the official WireGuard app.",
        "2. Use /vpn and select this user.",
        "3. Tap <b>Show QR</b> and scan it.",
        "4. Save and activate the tunnel.",
        "5. Verify handshake and traffic.",
        "",
        "🔐 The QR and configuration contain private keys. Do not share them.",
      ].join("\n"));
      return;
    }
    const pendingMessageId = pendingListAdd.get(chatId);
    if (pendingMessageId !== undefined) {
      if (text.startsWith("/")) {
        pendingListAdd.delete(chatId);
      } else {
        try {
          const result = await api("/admin/lists", {
            method: "POST",
            body: JSON.stringify({ url: text }),
          });
          pendingListAdd.delete(chatId);

          await editListsHome(chatId, pendingMessageId);
           return;
        } catch (error) {
          await sendMessage(
            chatId,
            `❌ <b>Unable to add blocklist</b>\n\n${codeHtml(error instanceof Error ? error.message : String(error))}\n\nSend another HTTPS URL or use /lists to cancel.`,
          );
          return;
        }
      }
    }

    if (text === "/start" || text === "/help") {
      await sendMessage(chatId, helpText());
      return;
    }

    if (text === "/status") {
      const status = await api("/admin/status");
      const listErrors = Number(status.blocklistErrors ?? 0);

      await sendMessage(chatId, [
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
      ].join("\n"));
      return;
    }

    if (text === "/diag") {
      const [healthResult, readyResult, updaterResult] = await Promise.allSettled([
        api("/health"),
        api("/ready"),
        updaterApi("/status"),
      ]);

      const health = healthResult.status === "fulfilled"
        ? `✅ OK · ${escapeHtml(healthResult.value.statsStorage ?? "unknown")}`
        : `❌ ${escapeHtml(healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason))}`;

      const ready = readyResult.status === "fulfilled"
        ? `✅ OK · ${escapeHtml(readyResult.value.statsStorage ?? "unknown")}`
        : `❌ ${escapeHtml(readyResult.reason instanceof Error ? readyResult.reason.message : String(readyResult.reason))}`;

      const updaterState = updaterResult.status === "fulfilled"
        ? updaterResult.value.running
          ? "updating"
          : updaterResult.value.lastSuccess === true
            ? "success"
            : updaterResult.value.lastSuccess === false
              ? "failed"
              : "idle"
        : "error";

      const updaterLine = updaterResult.status === "fulfilled"
        ? `${serviceIcon(updaterState)} ${escapeHtml(updaterState)} · ${codeHtml(String(updaterResult.value.currentSha ?? "-").slice(0, 8))}`
        : `❌ ${escapeHtml(updaterResult.reason instanceof Error ? updaterResult.reason.message : String(updaterResult.reason))}`;

      const runtimeLine = updaterResult.status === "fulfilled"
        ? `Updater gen ${escapeHtml(updaterResult.value.runtimeGeneration ?? "legacy")} · Bot gen ${escapeHtml(botRuntimeGeneration)}`
        : `Bot gen ${escapeHtml(botRuntimeGeneration)}`;

      const serviceLines = updaterResult.status === "fulfilled" && updaterResult.value.services
        ? [
            `${serviceIcon(updaterResult.value.services.dohA)} doh-a · ${escapeHtml(updaterResult.value.services.dohA ?? "unknown")}`,
            `${serviceIcon(updaterResult.value.services.dohB)} doh-b · ${escapeHtml(updaterResult.value.services.dohB ?? "unknown")}`,
            `${serviceIcon(updaterResult.value.services.wireguard)} WireGuard · ${escapeHtml(updaterResult.value.services.wireguard ?? "unknown")}`,
            `${serviceIcon(updaterResult.value.services.httpsProxy)} HTTPS proxy · ${escapeHtml(updaterResult.value.services.httpsProxy ?? "stopped")}`,
            `${serviceIcon(updaterResult.value.services.telegram)} Telegram bot · ${escapeHtml(updaterResult.value.services.telegram ?? "unknown")}`,
          ]
        : [];

      await sendMessage(chatId, [
        "🩺 <b>Diagnostics</b>",
        "",
        `<b>Resolver</b>  ${health}`,
        `<b>Storage</b>   ${ready}`,
        `<b>Updater</b>   ${updaterLine}`,
        "",
        "<b>Services</b>",
        ...(serviceLines.length ? serviceLines.map(line => `• ${line}`) : ["• Service details unavailable"]),
        "",
        `<b>Runtime</b>\n${runtimeLine}`,
      ].join("\n"));
      return;
    }

    if (text === "/domains") {
      const data = await getDomainsPage(0);

      if (!data.items.length) {
        await sendMessage(chatId, "🌐 <b>Observed Domains</b>\n\nNo domains have been observed yet.");
        return;
      }

      const view = domainsListView(data);
      await sendMessage(chatId, view.text, {
        reply_markup: view.reply_markup,
      });
      return;
    }

    if (text === "/lists") {
      pendingListAdd.delete(chatId);
      const data = await getLists();
      const view = listsView(data);
      await sendMessage(chatId, view.text, {
        reply_markup: view.reply_markup,
      });
      return;
    }

    if (text === "/vpn") {
      pendingPeerAdd.delete(chatId); const view = await vpnView(); await sendMessage(chatId, view.text, { reply_markup: view.reply_markup }); return;
    }

    if (text === "/integrations" || text === "/integrazioni") {
      const data = await getIntegrations();
      const view = integrationsHomeView(data);
      await sendMessage(chatId, view.text, { reply_markup: view.reply_markup });
      return;
    }

    if (text === "/topblocked") {
      const s = await api("/admin/top?decision=block");
      const lines = (s.items ?? []).map((x: any, i: number) => {
        const rule = x.matchedRule && x.matchedRule !== x.domain
          ? ` · ↳ ${codeHtml(x.matchedRule)}`
          : "";
        return `${i + 1}. ${codeHtml(x.domain)} — <b>${formatCount(x.count)}</b> · ${escapeHtml(topSourceLabel(x))}${rule}`;
      });

      await sendMessage(chatId, lines.length
        ? ["🚫 <b>Top Blocked Domains</b>", "", ...lines].join("\n")
        : "🚫 <b>Top Blocked Domains</b>\n\nNo blocked domains yet.");
      return;
    }

    if (text === "/topallowed") {
      const s = await api("/admin/top?decision=allow");
      const lines = (s.items ?? []).map((x: any, i: number) =>
        `${i + 1}. ${codeHtml(x.domain)} — <b>${formatCount(x.count)}</b> · ${escapeHtml(topSourceLabel(x))}`
      );

      await sendMessage(chatId, lines.length
        ? ["✅ <b>Top Requested Domains</b>", "", ...lines].join("\n")
        : "✅ <b>Top Requested Domains</b>\n\nNo allowed domains yet.");
      return;
    }

    if (text === "/reload") {
      await api("/admin/reload", { method: "POST", body: "{}" });
      await sendMessage(chatId, "✅ <b>Rules Reloaded</b>\n\nDNS filtering rules are active with the latest configuration.");
      return;
    }

    if (text === "/update") {
      await updaterApi("/update", { method: "POST", body: "{}" });
      await sendMessage(chatId, "🔄 <b>Update Started</b>\n\nTunnelBlock is updating in the background.\nUse /update_status to follow progress.");
      return;
    }

    if (text === "/update_status") {
      const s = await updaterApi("/status");
      const state = s.running
        ? "running"
        : s.lastSuccess === true
          ? "success"
          : s.lastSuccess === false
            ? "failed"
            : "idle";
      const icon = state === "running" ? "🔄" : state === "success" ? "✅" : state === "failed" ? "❌" : "⚪";
      const output = typeof s.lastOutput === "string" ? s.lastOutput.slice(-2500) : "";

      await sendMessage(chatId, [
        `${icon} <b>Update Status</b>`,
        "",
        `<b>State</b>     ${escapeHtml(state)}`,
        `<b>Started</b>   ${escapeHtml(s.lastStartedAt ?? "-")}`,
        `<b>Finished</b>  ${escapeHtml(s.lastFinishedAt ?? "-")}`,
        output ? `\n<b>Latest output</b>\n<pre>${escapeHtml(output)}</pre>` : "",
      ].filter(Boolean).join("\n"));
      return;
    }

    await sendMessage(chatId, helpText());
  } catch (error) {
    await sendMessage(chatId, `❌ <b>Operation Failed</b>\n\n${codeHtml(error instanceof Error ? error.message : String(error))}`);
  }
});
