import fs from "node:fs";
import path from "node:path";
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

const cleanupIntervalMs = Number(process.env.TELEGRAM_CLEANUP_INTERVAL_HOURS ?? 12) * 60 * 60 * 1000;
const cleanupDataDir = process.env.TELEGRAM_DATA_DIR ?? "/telegram-data";
const cleanupFile = path.join(cleanupDataDir, "messages.json");

type TrackedMessage = {
  chatId: number;
  messageId: number;
  createdAt: number;
};

fs.mkdirSync(cleanupDataDir, { recursive: true });

function loadTrackedMessages(): TrackedMessage[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(cleanupFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let trackedMessages: TrackedMessage[] = loadTrackedMessages();

function persistTrackedMessages() {
  const tmp = `${cleanupFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(trackedMessages));
  fs.renameSync(tmp, cleanupFile);
}

function trackMessage(chatId: number, messageId: number, createdAt = Date.now()) {
  if (trackedMessages.some(item => item.chatId === chatId && item.messageId === messageId)) return;
  trackedMessages.push({ chatId, messageId, createdAt });
  persistTrackedMessages();
}

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!adminToken) throw new Error("ADMIN_API_TOKEN is required");

const bot = new TelegramBot(token, { polling: true });

async function sendTrackedMessage(
  chatId: number,
  text: string,
  options?: TelegramBot.SendMessageOptions,
) {
  const sent = await bot.sendMessage(chatId, text, options);
  trackMessage(sent.chat.id, sent.message_id, (sent.date ?? Math.floor(Date.now() / 1000)) * 1000);
  return sent;
}

async function cleanupTrackedMessages() {
  if (trackedMessages.length === 0) return;

  const snapshot = [...trackedMessages];
  const remaining: TrackedMessage[] = [];

  for (const item of snapshot) {
    try {
      await bot.deleteMessage(item.chatId, item.messageId);
    } catch (error: any) {
      const ageMs = Date.now() - item.createdAt;
      const description = String(error?.response?.body?.description ?? error?.message ?? error);

      // Telegram cannot delete messages older than 48 hours. Do not retry those forever.
      if (ageMs < 48 * 60 * 60 * 1000 && !/message to delete not found/i.test(description)) {
        remaining.push(item);
      }
    }

    // Avoid hammering the Telegram API when /domains has produced many messages.
    await new Promise(resolve => setTimeout(resolve, 40));
  }

  trackedMessages = remaining;
  persistTrackedMessages();
}

await bot.setMyCommands([
  { command: "status", description: "Stato del resolver VPN" },
  { command: "diag", description: "Diagnostica resolver e storage" },
  { command: "domains", description: "Gestisci domini Allow / Block" },
  { command: "lists", description: "Gestisci blocklist esterne" },
  { command: "vpn", description: "Gestisci utenti VPN" },
  { command: "integrations", description: "Gestisci integrazioni HTTPS" },
  { command: "topblocked", description: "Domini più bloccati" },
  { command: "topallowed", description: "Domini più richiesti" },
  { command: "update", description: "Aggiorna AdBlock" },
  { command: "update_status", description: "Stato aggiornamento" },
  { command: "help", description: "Mostra i comandi" },
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
    text: `${stateIcon(item.state)} ${item.domain} · ${item.count}`,
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
    text: `🌐 Domini osservati\n${data.total} domini · pagina ${data.page + 1}/${data.pageCount}\n\nTocca un dominio per gestirlo.`,
    reply_markup: { inline_keyboard: rows },
  };
}

function domainStateLabel(state: string): string {
  if (state === "allow") return "Allow manuale";
  if (state === "block") return "Block manuale";
  if (state === "list") return "Blocklist";
  return "Default";
}

function domainDetailView(item: any, page: number) {
  const lines = [
    `${stateIcon(item.state)} ${item.domain}`,
    "",
    `Query: ${item.count}`,
    `Decisione DNS: ${item.decision === "block" ? "🚫 BLOCK" : "✅ ALLOW"}`,
    `Origine: ${domainStateLabel(item.state)}`,
  ];

  if (item.matchedRule) {
    lines.push(`Regola effettiva: ${item.matchedRule}`);
  }

  const matchingLists = Array.isArray(item.blocklists)
    ? item.blocklists
    : item.blocklist
      ? [item.blocklist]
      : [];

  if (matchingLists.length) {
    lines.push(
      item.state === "list"
        ? `Blocklist corrispondenti: ${matchingLists.length}`
        : `Presente anche in ${matchingLists.length} blocklist:`,
    );

    for (const match of matchingLists.slice(0, 5)) {
      lines.push(
        `• 📚 ${shortListName(match.url)} → ${match.matchedRule ?? item.domain}`,
      );
    }

    if (matchingLists.length > 5) {
      lines.push(`• … altre ${matchingLists.length - 5}`);
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
        [{ text: "⬅️ Torna alla lista", callback_data: `domains:p:${page}` }],
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
  rows.push([{ text: "➕ Nuovo utente", callback_data: "vpn:add" }]);
  return { text: `👥 Utenti VPN\n${peers.length} configurati`, reply_markup: { inline_keyboard: rows } };
}

async function editVpnHome(chatId: number, messageId: number) {
  const view = await vpnView();
  await bot.editMessageText(view.text, { chat_id: chatId, message_id: messageId, reply_markup: view.reply_markup });
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
  if (!value) return "mai";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("it-IT");
}

async function getLists() {
  return api("/admin/lists");
}

function listsView(data: any) {
  const items = data.items ?? [];
  const rows = items.map((item: any) => ([{
    text: `${item.lastError ? "⚠️" : item.enabled ? "✅" : "⏸"} ${shortListName(item.url)} · ${item.cachedDomainCount ?? item.domainCount}`,
    callback_data: `lists:d:${item.id}`,
  }]));

  rows.push([
    { text: "➕ Aggiungi", callback_data: "lists:add" },
    { text: "🔄 Aggiorna tutte", callback_data: "lists:refresh" },
  ]);

  const activeCount = Number(data.activeCount ?? items.filter((item: any) => item.enabled).length);
  const duplicateEntries = Number(data.duplicateEntries ?? 0);
  const unhealthyCount = Number(data.unhealthyCount ?? items.filter((item: any) => item.lastError).length);

  return {
    text: [
      "📚 Blocklist esterne",
      `${activeCount}/${items.length} attive · ${data.combinedDomainCount ?? 0} domini unici`,
      `Overlap: ${duplicateEntries} voci duplicate${unhealthyCount ? ` · ⚠️ ${unhealthyCount} con errore` : ""}`,
      "",
      items.length
        ? "Tocca una lista per copertura, overlap e stato."
        : "Nessuna lista configurata. Il blocco resta solo manuale.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

function listDetailView(item: any) {
  const coverage = item.enabled
    ? [
        `Domini cache: ${item.cachedDomainCount ?? item.domainCount}`,
        `Unici a questa lista: ${item.uniqueDomainCount ?? 0}`,
        `Sovrapposti ad altre liste: ${item.overlapDomainCount ?? 0}`,
      ]
    : [
        `Domini cache: ${item.cachedDomainCount ?? item.domainCount}`,
        "Copertura attiva: disabilitata",
      ];

  return {
    text: [
      `${item.lastError ? "⚠️" : item.enabled ? "✅" : "⏸"} ${item.enabled ? "Attiva" : "Disabilitata"}`,
      shortListName(item.url),
      "",
      item.url,
      "",
      ...coverage,
      `Ultimo aggiornamento: ${formatListDate(item.updatedAt)}`,
      item.lastError ? `Ultimo errore: ${item.lastError}` : "Stato: OK",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: item.enabled ? "⏸ Disabilita" : "▶️ Abilita",
            callback_data: `lists:e:${item.id}:${item.enabled ? 0 : 1}`,
          },
          { text: "🔄 Aggiorna", callback_data: `lists:r:${item.id}` },
        ],
        [{ text: "🗑 Rimuovi", callback_data: `lists:c:${item.id}` }],
        [{ text: "⬅️ Torna alle liste", callback_data: "lists:home" }],
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
  return "⚪ Inattiva";
}

async function getIntegrations() {
  return updaterApi("/https/integrations");
}

function integrationsHomeView(data: any) {
  const items = Array.isArray(data.items) ? data.items : [];
  const runtime = data.runtime ?? {};
  const rows = items.map((item: any) => ([{
    text: `${runtime.active && runtime.integration === item.id ? "🟢" : "⚪"} ${item.name}`,
    callback_data: `integrations:d:${item.id}`,
  }]));

  rows.push([
    { text: "🔐 Prepara CA", callback_data: "integrations:ca:prepare" },
    { text: "📄 Scarica CA", callback_data: "integrations:ca:download" },
  ]);

  const activeText = runtime.active
    ? `${runtime.integration} · ${String(runtime.mode ?? "").toUpperCase()}`
    : "nessuna";

  return {
    text: [
      "🧩 Integrazioni HTTPS",
      `CA: ${runtime.caReady ? "✅ pronta" : "❌ non preparata"}`,
      `Attiva: ${activeText}`,
      `Proxy: ${runtime.proxyState ?? "unknown"} · HTTPS: ${runtime.interception ?? "unknown"} · QUIC: ${runtime.quic ?? "unknown"}`,
      "",
      items.length
        ? "Scegli un’integrazione per vedere le azioni disponibili."
        : "Nessuna integrazione registrata.",
      "",
      "La CA è condivisa tra tutte le integrazioni. Dopo averla scaricata, installala su iPhone e abilita la fiducia completa nelle impostazioni certificati.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

function integrationDetailView(item: any, runtime: any) {
  const activeHere = Boolean(runtime?.active && runtime.integration === item.id);
  const rows: any[][] = [];

  if (activeHere) {
    rows.push([{ text: "⏹ Ferma", callback_data: `integrations:a:${item.id}:stop` }]);
  } else {
    if (Array.isArray(item.actions) && item.actions.includes("observe")) {
      rows.push([{ text: "👁 Avvia osservazione", callback_data: `integrations:a:${item.id}:observe` }]);
    }
    if (Array.isArray(item.actions) && item.actions.includes("filter")) {
      rows.push([{ text: "🛡 Avvia filtro", callback_data: `integrations:a:${item.id}:filter` }]);
    }
  }

  rows.push([{ text: "🔄 Aggiorna stato", callback_data: `integrations:d:${item.id}` }]);
  rows.push([{ text: "⬅️ Integrazioni", callback_data: "integrations:home" }]);

  const observation = item.observation ?? {};
  const modifiedAt = observation.modifiedAt
    ? new Date(observation.modifiedAt).toLocaleString("it-IT")
    : "mai";

  return {
    text: [
      `🧩 ${item.name}`,
      integrationRuntimeLabel(item, runtime),
      "",
      item.description ?? "",
      "",
      `Stato strategia: ${item.status ?? "experimental"}`,
      `Azioni: ${Array.isArray(item.actions) && item.actions.length ? item.actions.join(", ") : "nessuna"}`,
      `CA: ${runtime?.caReady ? "✅ pronta" : "❌ non preparata"}`,
      `Log osservazione: ${formatBytes(Number(observation.bytes ?? 0))} · ultimo aggiornamento: ${modifiedAt}`,
      "",
      activeHere
        ? "L’intercettazione HTTPS è attiva sul traffico del dispositivo. Ferma la sessione appena terminato il test."
        : runtime?.caReady
          ? "Prima dell’avvio verifica che la CA sia installata e considerata attendibile da iOS."
          : "Prepara e installa prima la CA dal menu Integrazioni.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

async function editIntegrationsHome(chatId: number, messageId: number) {
  const data = await getIntegrations();
  const view = integrationsHomeView(data);
  await bot.editMessageText(view.text, {
    chat_id: chatId,
    message_id: messageId,
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
    reply_markup: view.reply_markup,
  });
}


function helpText(): string {
  return [
    "AdBlock bot commands:",
    "/status",
    "/diag",
    "/domains",
    "/lists",
    "/vpn",
    "/integrations",
    "/topblocked",
    "/topallowed",
    "/reload",
    "/update",
    "/update_status",
    "/help",
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

    if (data === "integrations:ca:prepare") {
      await bot.answerCallbackQuery(query.id, { text: "Preparazione CA…" });
      await updaterApi("/https/ca/prepare", { method: "POST", body: "{}" });
      await editIntegrationsHome(chatId, messageId);
      return;
    }

    if (data === "integrations:ca:download") {
      const result = await updaterApi("/https/ca");
      const sent = await bot.sendDocument(
        chatId,
        Buffer.from(result.base64, "base64"),
        {
          caption: "CA HTTPS AdBlock. Installala sul dispositivo di test e abilita la fiducia completa in iOS prima di avviare un’integrazione.",
        },
        {
          filename: result.filename ?? "adblock-https-ca.cer",
          contentType: result.contentType ?? "application/x-x509-ca-cert",
        },
      );
      trackMessage(sent.chat.id, sent.message_id);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const integrationDetail = data.match(/^integrations:d:([a-z0-9_-]{1,24})$/);
    if (integrationDetail) {
      await editIntegrationDetail(chatId, messageId, integrationDetail[1]);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const integrationAction = data.match(/^integrations:a:([a-z0-9_-]{1,24}):(observe|filter|stop)$/);
    if (integrationAction) {
      const [, id, action] = integrationAction;
      await bot.answerCallbackQuery(query.id, {
        text: action === "stop" ? "Arresto integrazione…" : "Avvio integrazione…",
      });
      await updaterApi(`/https/integrations/${id}/${action}`, {
        method: "POST",
        body: "{}",
      });
      await editIntegrationDetail(chatId, messageId, id);
      return;
    }

    if (data === "vpn:home") { pendingPeerAdd.delete(chatId); await editVpnHome(chatId, messageId); await bot.answerCallbackQuery(query.id); return; }
    if (data === "vpn:add") { pendingPeerAdd.set(chatId, messageId); await bot.editMessageText("➕ Nuovo utente VPN\n\nInvia un nome (lettere, numeri, _ o -).", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[{ text: "❌ Annulla", callback_data: "vpn:home" }]] } }); await bot.answerCallbackQuery(query.id); return; }
    const vpnDetail = data.match(/^vpn:d:([A-Za-z0-9_-]{1,32})$/);
    if (vpnDetail) { const peers = await updaterApi("/vpn/peers"); const peer = peers.find((p: any) => p.name === vpnDetail[1]); if (!peer) { await editVpnHome(chatId, messageId); return; } const last = peer.handshake ? new Date(peer.handshake * 1000).toLocaleString("it-IT") : "mai"; await bot.editMessageText(`👤 ${peer.name}\nStato: ${peer.enabled ? "abilitato" : "disabilitato"}\nIP: ${peer.ipv4}\nUltimo accesso: ${last}\nTraffico: ↓ ${peer.rx} B · ↑ ${peer.tx} B`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[{ text: peer.enabled ? "⏸ Disabilita" : "▶️ Abilita", callback_data: `vpn:e:${peer.name}:${peer.enabled ? 0 : 1}` }], [{ text: "📷 Mostra QR", callback_data: `vpn:g:${peer.name}` }, { text: "📄 Config", callback_data: `vpn:c:${peer.name}` }], [{ text: "🔑 Rigenera", callback_data: `vpn:r:${peer.name}` }, { text: "🗑 Elimina", callback_data: `vpn:q:${peer.name}` }], [{ text: "⬅️ Utenti", callback_data: "vpn:home" }]] } }); await bot.answerCallbackQuery(query.id); return; }
    const vpnEnable = data.match(/^vpn:e:([A-Za-z0-9_-]{1,32}):(0|1)$/);
    if (vpnEnable) { await updaterApi(`/vpn/peers/${vpnEnable[1]}/${vpnEnable[2] === "1" ? "enable" : "disable"}`, { method: "POST", body: "{}" }); await editVpnHome(chatId, messageId); await bot.answerCallbackQuery(query.id, { text: "Stato aggiornato" }); return; }
    const vpnConfig = data.match(/^vpn:c:([A-Za-z0-9_-]{1,32})$/);
    if (vpnConfig) { const result = await updaterApi(`/vpn/peers/${vpnConfig[1]}/config`); const sent = await bot.sendDocument(chatId, Buffer.from(result.config), {}, { filename: `${vpnConfig[1]}.conf`, contentType: "text/plain" }); trackMessage(sent.chat.id, sent.message_id); await bot.answerCallbackQuery(query.id); return; }
    const vpnQr = data.match(/^vpn:g:([A-Za-z0-9_-]{1,32})$/);
    if (vpnQr) { const result = await updaterApi(`/vpn/peers/${vpnQr[1]}/qr`); const sent = await bot.sendPhoto(chatId, Buffer.from(result.pngBase64, "base64"), { caption: `QR WireGuard · ${vpnQr[1]}` }, { filename: `${vpnQr[1]}.png`, contentType: "image/png" }); trackMessage(sent.chat.id, sent.message_id); await bot.answerCallbackQuery(query.id); return; }
    const vpnRotate = data.match(/^vpn:r:([A-Za-z0-9_-]{1,32})$/);
    if (vpnRotate) { await updaterApi(`/vpn/peers/${vpnRotate[1]}/rotate`, { method: "POST", body: "{}" }); await bot.answerCallbackQuery(query.id, { text: "Chiavi rigenerate: scarica la nuova config", show_alert: true }); return; }
    const vpnConfirm = data.match(/^vpn:q:([A-Za-z0-9_-]{1,32})$/);
    if (vpnConfirm) { await bot.editMessageText(`Eliminare definitivamente ${vpnConfirm[1]}?`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[{ text: "🗑 Conferma", callback_data: `vpn:x:${vpnConfirm[1]}` }], [{ text: "Annulla", callback_data: `vpn:d:${vpnConfirm[1]}` }]] } }); await bot.answerCallbackQuery(query.id); return; }
    const vpnDelete = data.match(/^vpn:x:([A-Za-z0-9_-]{1,32})$/);
    if (vpnDelete) { await updaterApi(`/vpn/peers/${vpnDelete[1]}`, { method: "DELETE" }); await editVpnHome(chatId, messageId); await bot.answerCallbackQuery(query.id, { text: "Utente eliminato" }); return; }
    if (data === "lists:home") {
      await editListsHome(chatId, messageId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === "lists:add") {
      pendingListAdd.set(chatId, messageId);
      await bot.editMessageText(
        "➕ Aggiungi blocklist\n\nInviami ora l’URL HTTPS della lista.\nSono supportati domini semplici, file hosts e sintassi Adblock ||domain^.",
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[
              { text: "❌ Annulla", callback_data: "lists:canceladd" },
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
      await bot.answerCallbackQuery(query.id, { text: "Aggiornamento liste avviato…" });
      const result = await api("/admin/lists/refresh", { method: "POST", body: "{}" });
      await editListsHome(chatId, messageId);
      if (result.failed) {
        await bot.answerCallbackQuery(query.id, {
          text: `Aggiornate: ${result.updated}, errori: ${result.failed}`,
          show_alert: true,
        }).catch(() => {});
      }
      return;
    }

    const listDetailMatch = data.match(/^lists:d:([a-f0-9]{12})$/);
    if (listDetailMatch) {
      const item = await getListById(listDetailMatch[1]);
      if (!item) {
        await bot.answerCallbackQuery(query.id, { text: "Lista non trovata.", show_alert: true });
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
        text: result.source.enabled ? "Lista abilitata" : "Lista disabilitata",
      });
      return;
    }

    const listRefreshMatch = data.match(/^lists:r:([a-f0-9]{12})$/);
    if (listRefreshMatch) {
      await bot.answerCallbackQuery(query.id, { text: "Aggiornamento…" });
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
        `🗑 Rimuovere questa blocklist?\n\n${shortListName(item.url)}\n${item.url}`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🗑 Sì, rimuovi", callback_data: `lists:x:${item.id}` }],
              [{ text: "⬅️ Annulla", callback_data: `lists:d:${item.id}` }],
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
      await bot.answerCallbackQuery(query.id, { text: "Lista rimossa" });
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
        await bot.answerCallbackQuery(query.id, { text: "Dominio non più presente in questa pagina.", show_alert: true });
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

    await bot.answerCallbackQuery(query.id, { text: "Azione non valida." });
  } catch (error) {
    await bot.answerCallbackQuery(query.id, {
      text: error instanceof Error ? error.message.slice(0, 180) : "Errore",
      show_alert: true,
    });
  }
});

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text ?? "").trim();

  trackMessage(chatId, msg.message_id, (msg.date ?? Math.floor(Date.now() / 1000)) * 1000);

  if (!isAllowed(userId)) {
    await sendTrackedMessage(chatId, "Unauthorized.");
    return;
  }

  try {
    const pendingPeerMessageId = pendingPeerAdd.get(chatId);
    if (pendingPeerMessageId !== undefined && !text.startsWith("/")) {
      await updaterApi("/vpn/peers", { method: "POST", body: JSON.stringify({ name: text }) });
      pendingPeerAdd.delete(chatId);
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      await editVpnHome(chatId, pendingPeerMessageId);
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

          try {
            await bot.deleteMessage(chatId, msg.message_id);
          } catch {}

          await editListsHome(chatId, pendingMessageId);
           return;
        } catch (error) {
          await sendTrackedMessage(
            chatId,
            `Impossibile aggiungere la lista: ${error instanceof Error ? error.message : String(error)}\n\nInvia un altro URL HTTPS oppure usa /lists per annullare.`,
          );
          return;
        }
      }
    }

    if (text === "/start" || text === "/help") {
      await sendTrackedMessage(chatId, helpText());
      return;
    }

    if (text === "/status") {
      const status = await api("/admin/status");
      await sendTrackedMessage(chatId,
        `DNS VPN: ${status.ok ? "online" : "offline"}\nUptime: ${status.uptimeSec}s\nQueries: ${status.queries}\nBlocked: ${status.blocked}\nBlock rate: ${status.blockRate}%\nBlocklist attive: ${status.blocklists ?? 0}\nDomini esterni unici: ${status.externalBlockedDomains ?? 0}\nDuplicati tra liste: ${status.blocklistDuplicateEntries ?? 0}\nListe in errore: ${status.blocklistErrors ?? 0}`
      );
      return;
    }

    if (text === "/diag") {
      const [healthResult, readyResult, updaterResult] = await Promise.allSettled([
        api("/health"),
        api("/ready"),
        updaterApi("/status"),
      ]);

      const health = healthResult.status === "fulfilled"
        ? `OK (${healthResult.value.statsStorage ?? "unknown"})`
        : `ERRORE: ${healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason)}`;

      const ready = readyResult.status === "fulfilled"
        ? `OK (${readyResult.value.statsStorage ?? "unknown"})`
        : `ERRORE: ${readyResult.reason instanceof Error ? readyResult.reason.message : String(readyResult.reason)}`;

      const updater = updaterResult.status === "fulfilled"
        ? `${updaterResult.value.running ? "running" : (updaterResult.value.lastSuccess === true ? "success" : updaterResult.value.lastSuccess === false ? "failed" : "idle")} @ ${updaterResult.value.currentSha ?? "-"}`
        : `ERRORE: ${updaterResult.reason instanceof Error ? updaterResult.reason.message : String(updaterResult.reason)}`;

      const runtimeLine = updaterResult.status === "fulfilled"
        ? `Runtime: updater gen ${updaterResult.value.runtimeGeneration ?? "legacy"} @ ${String(updaterResult.value.runtimeBuildSha ?? "unknown").slice(0, 8)} · bot gen ${botRuntimeGeneration}`
        : `Runtime: bot gen ${botRuntimeGeneration}`;

      const serviceLines = updaterResult.status === "fulfilled" && updaterResult.value.services
        ? [
            `doh-a: ${updaterResult.value.services.dohA ?? "unknown"}`,
            `doh-b: ${updaterResult.value.services.dohB ?? "unknown"}`,
            `wireguard: ${updaterResult.value.services.wireguard ?? "unknown"}`,
            `https-proxy: ${updaterResult.value.services.httpsProxy ?? "stopped"}`,
            `bot: ${updaterResult.value.services.telegram ?? "unknown"}`,
          ]
        : [];

      await sendTrackedMessage(
        chatId,
        [
          "🩺 Diagnostica",
          `Resolver: ${health}`,
          `Storage ready: ${ready}`,
          `Updater: ${updater}`,
          runtimeLine,
          ...serviceLines,
        ].join("\n"),
      );
      return;
    }

    if (text === "/domains") {
      const data = await getDomainsPage(0);

      if (!data.items.length) {
        await sendTrackedMessage(chatId, "Nessun dominio osservato.");
        return;
      }

      const view = domainsListView(data);
      await sendTrackedMessage(chatId, view.text, {
        reply_markup: view.reply_markup,
      });
      return;
    }

    if (text === "/lists") {
      pendingListAdd.delete(chatId);
      const data = await getLists();
      const view = listsView(data);
      await sendTrackedMessage(chatId, view.text, {
        reply_markup: view.reply_markup,
      });
      return;
    }

    if (text === "/vpn") {
      pendingPeerAdd.delete(chatId); const view = await vpnView(); await sendTrackedMessage(chatId, view.text, { reply_markup: view.reply_markup }); return;
    }

    if (text === "/integrations" || text === "/integrazioni") {
      const data = await getIntegrations();
      const view = integrationsHomeView(data);
      await sendTrackedMessage(chatId, view.text, { reply_markup: view.reply_markup });
      return;
    }

    if (text === "/topblocked") {
      const s = await api("/admin/top?decision=block");
      const lines = (s.items ?? []).map((x: any, i: number) => {
        const rule = x.matchedRule && x.matchedRule !== x.domain
          ? ` · ↳ ${x.matchedRule}`
          : "";
        return `${i + 1}. ${x.domain} — ${x.count} · ${topSourceLabel(x)}${rule}`;
      });
      await sendTrackedMessage(chatId, lines.length ? lines.join("\n") : "No blocked domains yet.");
      return;
    }

    if (text === "/topallowed") {
      const s = await api("/admin/top?decision=allow");
      const lines = (s.items ?? []).map((x: any, i: number) =>
        `${i + 1}. ${x.domain} — ${x.count} · ${topSourceLabel(x)}`
      );
      await sendTrackedMessage(chatId, lines.length ? lines.join("\n") : "No allowed domains yet.");
      return;
    }

    if (text === "/reload") {
      await api("/admin/reload", { method: "POST", body: "{}" });
      await sendTrackedMessage(chatId, "Rules reloaded.");
      return;
    }

    if (text === "/update") {
      await updaterApi("/update", { method: "POST", body: "{}" });
      await sendTrackedMessage(chatId, "Update started. Use /update_status to follow progress.");
      return;
    }

    if (text === "/update_status") {
      const s = await updaterApi("/status");
      const state = s.running ? "running" : (s.lastSuccess === true ? "success" : (s.lastSuccess === false ? "failed" : "idle"));
      const output = typeof s.lastOutput === "string" ? s.lastOutput.slice(-2500) : "";
      await sendTrackedMessage(chatId,
        `Update: ${state}\nStarted: ${s.lastStartedAt ?? "-"}\nFinished: ${s.lastFinishedAt ?? "-"}${output ? "\n\n" + output : ""}`
      );
      return;
    }

    await sendTrackedMessage(chatId, helpText());
  } catch (error) {
    await sendTrackedMessage(chatId, `Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});


setInterval(() => {
  void cleanupTrackedMessages();
}, cleanupIntervalMs);
