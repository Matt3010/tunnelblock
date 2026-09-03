import TelegramBot from "node-telegram-bot-api";
import { isAllowedUser, isPrivateChat, parseAllowedUserIds } from "./access.js";
import {
  codeHtml,
  diagnosticsText,
  domainDetailView,
  domainsListView,
  escapeHtml,
  formatBytes,
  formatCount,
  helpText,
  httpsSummaryText,
  integrationDetailView,
  integrationsHomeView,
  listDetailView,
  listsView,
  serviceIcon,
  shortListName,
  statusText,
  topSourceLabel,
  updateStatusText,
} from "./presentation.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminBase = process.env.ADMIN_API_BASE ?? "http://doh:8053";
const updaterBase = process.env.UPDATER_API_BASE ?? "http://updater:8090";
const adminToken = process.env.ADMIN_API_TOKEN;
const botRuntimeGeneration = process.env.BOT_RUNTIME_GENERATION ?? "unknown";
const allowed = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS ?? "");

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!adminToken) throw new Error("ADMIN_API_TOKEN is required");

const bot = new TelegramBot(token, { polling: true });

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

const BOT_COMMANDS = [
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
];

const commandChats = new Set<number>();

async function ensureCommandsForChat(chatId: number): Promise<void> {
  if (commandChats.has(chatId)) return;
  await bot.setMyCommands(BOT_COMMANDS, {
    scope: { type: "chat", chat_id: chatId },
  });
  commandChats.add(chatId);
}

// No global command menu: unauthorized users should not see the control surface.
await bot.deleteMyCommands();
for (const rawUserId of allowed) {
  const chatId = Number(rawUserId);
  if (!Number.isSafeInteger(chatId)) continue;
  await ensureCommandsForChat(chatId).catch(() => {});
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

async function getLists() {
  return api("/admin/lists");
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

async function getIntegrations() {
  return updaterApi("/integrations");
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


bot.on("callback_query", async query => {
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data ?? "";

  if (!chatId || !messageId) {
    await bot.answerCallbackQuery(query.id, { text: "Unavailable." });
    return;
  }

  if (!isPrivateChat(query.message?.chat.type)) {
    await bot.answerCallbackQuery(query.id, { text: "Private chat only." });
    return;
  }

  if (!isAllowedUser(allowed, userId)) {
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
        await bot.answerCallbackQuery(query.id, { text: "User no longer exists." });
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
        parse_mode: "HTML",
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
        parse_mode: "HTML",
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
        parse_mode: "HTML",
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
        parse_mode: "HTML",
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
        parse_mode: "HTML",
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

  // Never expose VPN, DNS or certificate data in groups/channels.
  if (!isPrivateChat(msg.chat.type)) return;

  if (!isAllowedUser(allowed, userId)) {
    await sendMessage(chatId, "⛔ <b>Unauthorized</b>\n\nThis bot is restricted to approved users.");
    return;
  }

  await ensureCommandsForChat(chatId).catch(() => {});

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
      await sendMessage(chatId, statusText(status));
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

      await sendMessage(chatId, diagnosticsText({
        health,
        ready,
        updaterLine,
        serviceLines,
        runtimeLine,
      }));
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
      const status = await updaterApi("/status");
      await sendMessage(chatId, updateStatusText(status));
      return;
    }

    await sendMessage(chatId, helpText());
  } catch (error) {
    await sendMessage(chatId, `❌ <b>Operation Failed</b>\n\n${codeHtml(error instanceof Error ? error.message : String(error))}`);
  }
});
