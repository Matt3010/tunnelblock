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
  { command: "status", description: "Stato del resolver DoH" },
  { command: "diag", description: "Diagnostica resolver e storage" },
  { command: "domains", description: "Gestisci domini Allow / Block" },
  { command: "lists", description: "Gestisci blocklist esterne" },
  { command: "topblocked", description: "Domini più bloccati" },
  { command: "topallowed", description: "Domini più richiesti" },
  { command: "profile", description: "Link profilo iPhone" },
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
    lines.push(`Regola: ${item.matchedRule}`);
  }

  if (item.blocklist?.url) {
    const listName = shortListName(item.blocklist.url);
    if (item.state === "list") {
      lines.push(`Lista: 📚 ${listName}`);
    } else {
      lines.push(`Presente anche in: 📚 ${listName}`);
    }
    if (item.blocklist.matchedRule) {
      lines.push(`Match lista: ${item.blocklist.matchedRule}`);
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
    text: `${item.enabled ? "✅" : "⏸"} ${shortListName(item.url)} · ${item.domainCount}`,
    callback_data: `lists:d:${item.id}`,
  }]));

  rows.push([
    { text: "➕ Aggiungi", callback_data: "lists:add" },
    { text: "🔄 Aggiorna tutte", callback_data: "lists:refresh" },
  ]);

  return {
    text: [
      "📚 Blocklist esterne",
      `${items.length} liste · ${data.combinedDomainCount ?? 0} domini attivi`,
      "",
      items.length
        ? "Tocca una lista per gestirla."
        : "Nessuna lista configurata. Il blocco resta solo manuale.",
    ].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

function listDetailView(item: any) {
  return {
    text: [
      `${item.enabled ? "✅ Attiva" : "⏸ Disabilitata"}`,
      shortListName(item.url),
      "",
      item.url,
      "",
      `Domini: ${item.domainCount}`,
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

function helpText(): string {
  return [
    "AdBlock bot commands:",
    "/status",
    "/diag",
    "/domains",
    "/lists",
    "/topblocked",
    "/topallowed",
    "/reload",
    "/profile",
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
        `DoH: ${status.ok ? "online" : "offline"}\nUptime: ${status.uptimeSec}s\nQueries: ${status.queries}\nBlocked: ${status.blocked}\nBlock rate: ${status.blockRate}%\nBlocklist attive: ${status.blocklists ?? 0}\nDomini esterni: ${status.externalBlockedDomains ?? 0}`
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
        ? `Runtime: updater gen ${updaterResult.value.runtimeGeneration ?? "legacy"} · bot gen ${botRuntimeGeneration}`
        : `Runtime: bot gen ${botRuntimeGeneration}`;

      const serviceLines = updaterResult.status === "fulfilled" && updaterResult.value.services
        ? [
            `doh-a: ${updaterResult.value.services.dohA ?? "unknown"}`,
            `doh-b: ${updaterResult.value.services.dohB ?? "unknown"}`,
            `proxy: ${updaterResult.value.services.proxy ?? "unknown"}`,
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

    if (text === "/topblocked") {
      const s = await api("/admin/top?decision=block");
      const lines = (s.items ?? []).map((x: any, i: number) => `${i+1}. ${x.domain} — ${x.count}`);
      await sendTrackedMessage(chatId, lines.length ? lines.join("\n") : "No blocked domains yet.");
      return;
    }

    if (text === "/topallowed") {
      const s = await api("/admin/top?decision=allow");
      const lines = (s.items ?? []).map((x: any, i: number) => `${i+1}. ${x.domain} — ${x.count}`);
      await sendTrackedMessage(chatId, lines.length ? lines.join("\n") : "No allowed domains yet.");
      return;
    }

    if (text === "/reload") {
      await api("/admin/reload", { method: "POST", body: "{}" });
      await sendTrackedMessage(chatId, "Rules reloaded.");
      return;
    }

    if (text === "/profile") {
      await sendTrackedMessage(chatId, "https://adblock.scanferlamatteo.work/install");
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
