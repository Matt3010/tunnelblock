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

function isAllowed(userId?: number): boolean {
  if (!userId) return false;
  return allowed.has(String(userId));
}

async function requestJson(base: string, path: string, init?: RequestInit) {
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
    "/topblocked",
    "/topallowed",
    "/block domain.com",
    "/allow domain.com",
    "/unblock domain.com",
    "/unallow domain.com",
    "/reload",
    "/profile",
    "/update",
    "/update_status",
    "/help",
  ].join("\n");
}

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

    const ruleMatch = text.match(/^\/(block|allow|unblock|unallow)\s+([^\s]+)$/i);
    if (ruleMatch) {
      const [, action, domain] = ruleMatch;
      await api("/admin/rules", {
        method: "POST",
        body: JSON.stringify({ action: action.toLowerCase(), domain }),
      });
      await bot.sendMessage(chatId, `${action.toLowerCase()} applied to ${domain}`);
      return;
    }

    await bot.sendMessage(chatId, helpText());
  } catch (error) {
    await bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});
