import fs from "node:fs";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminBase = process.env.ADMIN_API_BASE ?? "http://doh:8053";
const updaterBase = process.env.UPDATER_API_BASE ?? "http://updater:8090";
const adminToken = process.env.ADMIN_API_TOKEN;
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
  { command: "stats", description: "Statistiche DNS" },
  { command: "domains", description: "Gestisci domini Allow / Block" },
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
        throw new Error(`Admin API ${res.status}: ${text}`);
      }

      return body as any;
    } catch (error) {
      lastError = error;
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
  return state === "allow" ? "✅" : state === "block" ? "🚫" : "⚪";
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

function domainDetailView(item: any, page: number) {
  return {
    text: `${stateIcon(item.state)} ${item.domain}\n\nQuery: ${item.count}\nStato: ${item.state}`,
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

function helpText(): string {
  return [
    "AdBlock bot commands:",
    "/status",
    "/stats",
    "/domains",
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
        state: action,
      };
      updated.state = action;

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
    if (text === "/start" || text === "/help") {
      await sendTrackedMessage(chatId, helpText());
      return;
    }

    if (text === "/status") {
      const status = await api("/admin/status");
      await sendTrackedMessage(chatId,
        `DoH: ${status.ok ? "online" : "offline"}\nUptime: ${status.uptimeSec}s\nQueries: ${status.queries}\nBlocked: ${status.blocked}\nBlock rate: ${status.blockRate}%`
      );
      return;
    }

    if (text === "/stats") {
      const s = await api("/admin/stats");
      await sendTrackedMessage(chatId,
        `Queries: ${s.queries}\nAllowed: ${s.allowed}\nBlocked: ${s.blocked}\nBlock rate: ${s.blockRate}%`
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
