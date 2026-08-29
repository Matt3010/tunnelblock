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

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!adminToken) throw new Error("ADMIN_API_TOKEN is required");

const bot = new TelegramBot(token, { polling: true });

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
  const data = query.data ?? "";

  if (!chatId || !isAllowed(userId)) {
    await bot.answerCallbackQuery(query.id, { text: "Unauthorized." });
    return;
  }

  const match = data.match(/^rule:(default|allow|block):([a-f0-9]{16})$/);
  if (!match) {
    await bot.answerCallbackQuery(query.id, { text: "Invalid action." });
    return;
  }

  const [, action, key] = match;

  try {
    const result = await api("/admin/rules/by-key", {
      method: "POST",
      body: JSON.stringify({ action, key }),
    });

    await bot.answerCallbackQuery(query.id, {
      text: action === "allow" ? "Allowed" : action === "block" ? "Blocked" : "Default",
    });

    if (query.message) {
      const icon = action === "allow" ? "✅" : action === "block" ? "🚫" : "⚪";
      await bot.editMessageText(
        `${icon} ${result.domain}\nState: ${action}`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: {
            inline_keyboard: [[
              { text: "⚪ Default", callback_data: `rule:default:${key}` },
              { text: "✅ Allow", callback_data: `rule:allow:${key}` },
              { text: "🚫 Block", callback_data: `rule:block:${key}` },
            ]],
          },
        },
      );
    }
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
    await bot.sendMessage(chatId, "Unauthorized.");
    return;
  }

  try {
    if (text === "/start" || text === "/help") {
      await bot.sendMessage(chatId, helpText());
      return;
    }

    if (text === "/status") {
      const status = await api("/admin/status");
      await bot.sendMessage(chatId,
        `DoH: ${status.ok ? "online" : "offline"}\nUptime: ${status.uptimeSec}s\nQueries: ${status.queries}\nBlocked: ${status.blocked}\nBlock rate: ${status.blockRate}%`
      );
      return;
    }

    if (text === "/stats") {
      const s = await api("/admin/stats");
      await bot.sendMessage(chatId,
        `Queries: ${s.queries}\nAllowed: ${s.allowed}\nBlocked: ${s.blocked}\nBlock rate: ${s.blockRate}%`
      );
      return;
    }

    if (text === "/domains") {
      const s = await api("/admin/domains?limit=12");
      const items = s.items ?? [];

      if (!items.length) {
        await bot.sendMessage(chatId, "No domains observed yet.");
        return;
      }

      for (const item of items) {
        const icon = item.state === "allow" ? "✅" : item.state === "block" ? "🚫" : "⚪";
        await bot.sendMessage(
          chatId,
          `${icon} ${item.domain}\nQueries: ${item.count}\nState: ${item.state}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "⚪ Default", callback_data: `rule:default:${item.key}` },
                { text: "✅ Allow", callback_data: `rule:allow:${item.key}` },
                { text: "🚫 Block", callback_data: `rule:block:${item.key}` },
              ]],
            },
          },
        );
      }
      return;
    }

    if (text === "/topblocked") {
      const s = await api("/admin/top?decision=block");
      const lines = (s.items ?? []).map((x: any, i: number) => `${i+1}. ${x.domain} — ${x.count}`);
      await bot.sendMessage(chatId, lines.length ? lines.join("\n") : "No blocked domains yet.");
      return;
    }

    if (text === "/topallowed") {
      const s = await api("/admin/top?decision=allow");
      const lines = (s.items ?? []).map((x: any, i: number) => `${i+1}. ${x.domain} — ${x.count}`);
      await bot.sendMessage(chatId, lines.length ? lines.join("\n") : "No allowed domains yet.");
      return;
    }

    if (text === "/reload") {
      await api("/admin/reload", { method: "POST", body: "{}" });
      await bot.sendMessage(chatId, "Rules reloaded.");
      return;
    }

    if (text === "/profile") {
      await bot.sendMessage(chatId, "https://adblock.scanferlamatteo.work/install");
      return;
    }

    if (text === "/update") {
      await updaterApi("/update", { method: "POST", body: "{}" });
      await bot.sendMessage(chatId, "Update started. Use /update_status to follow progress.");
      return;
    }

    if (text === "/update_status") {
      const s = await updaterApi("/status");
      const state = s.running ? "running" : (s.lastSuccess === true ? "success" : (s.lastSuccess === false ? "failed" : "idle"));
      const output = typeof s.lastOutput === "string" ? s.lastOutput.slice(-2500) : "";
      await bot.sendMessage(chatId,
        `Update: ${state}\nStarted: ${s.lastStartedAt ?? "-"}\nFinished: ${s.lastFinishedAt ?? "-"}${output ? "\n\n" + output : ""}`
      );
      return;
    }

    await bot.sendMessage(chatId, helpText());
  } catch (error) {
    await bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});
