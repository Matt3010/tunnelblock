import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import { LoginLimiter, credentialsMatch, parseBasicAuth } from "./auth.js";
import { applyLanChange, lanDevices, lanSummary, type LanAcl, type LanChange } from "./lan.js";
import { isPrivateAddress } from "./net.js";

export type AppOptions = {
  user: string;
  password: string;
  adminToken: string;
  adminBase: string;
  updaterBase: string;
  publicDir: string;
  fetchImpl?: typeof fetch;
  logger?: boolean;
};

type Upstream = { status: number; body: any };

const DOMAINS_PAGE_SIZE = 20;
const peerName = /^[A-Za-z0-9_-]{1,32}$/;
const listId = /^[a-f0-9]{12}$/;
const domainKey = /^[a-f0-9]{16}$/;
const integrationPart = /^[a-z0-9_-]{1,24}$/;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Only files present at startup are served; request paths never reach the filesystem.
function loadPublicFiles(dir: string): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const name of fs.readdirSync(dir)) {
    const type = contentTypes[path.extname(name)];
    const file = path.join(dir, name);
    if (type && fs.statSync(file).isFile()) files.set(name, { body: fs.readFileSync(file), type });
  }
  return files;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false });
  const fetchImpl = options.fetchImpl ?? fetch;
  const limiter = new LoginLimiter(5, 15 * 60_000);
  const expected = { user: options.user, password: options.password };
  const publicFiles = loadPublicFiles(options.publicDir);

  app.addHook("onRequest", async (request, reply) => {
    reply.headers({
      "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });

    const source = request.socket.remoteAddress ?? "";
    if (!isPrivateAddress(source)) return reply.code(403).send({ error: "forbidden" });
    if (limiter.blocked(source)) return reply.code(429).send({ error: "too many failed logins, retry later" });

    const header = request.headers.authorization;
    if (!credentialsMatch(expected, parseBasicAuth(header))) {
      // The browser's first, credential-less request is not a failed attempt.
      if (header) limiter.fail(source);
      return reply
        .code(401)
        .header("www-authenticate", 'Basic realm="TunnelBlock", charset="UTF-8"')
        .send({ error: "unauthorized" });
    }
    limiter.succeed(source);

    // Browsers resend Basic credentials cross-site, so writes must come from this page.
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.origin;
      if (origin) {
        let host: string | null = null;
        try { host = new URL(origin).host; } catch {}
        if (host !== request.headers.host) return reply.code(403).send({ error: "cross-site request refused" });
      }
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 502;
    reply.code(status).send({ error: error.message });
  });

  async function call(base: string, pathname: string, init?: { method?: string; body?: unknown }): Promise<Upstream> {
    const res = await fetchImpl(`${base}${pathname}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.adminToken}` },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  }

  const admin = (pathname: string, init?: { method?: string; body?: unknown }) => call(options.adminBase, pathname, init);
  const updater = (pathname: string, init?: { method?: string; body?: unknown }) => call(options.updaterBase, pathname, init);

  function relay(reply: FastifyReply, result: Upstream) {
    const body = result.status >= 400 && typeof result.body === "string" ? { error: result.body } : result.body;
    return reply.code(result.status).send(body);
  }

  function badRequest(reply: FastifyReply, error = "invalid request") {
    return reply.code(400).send({ error });
  }

  // ---- Static page -------------------------------------------------------

  app.get("/*", async (request, reply) => {
    const name = (request.params as { "*": string })["*"] || "index.html";
    const file = publicFiles.get(name);
    if (!file) return reply.code(404).send({ error: "not found" });
    return reply.type(file.type).send(file.body);
  });

  // ---- Overview ----------------------------------------------------------

  app.get("/api/status", async (_request, reply) => relay(reply, await admin("/admin/status")));

  app.get("/api/diag", async () => {
    const [health, ready, update] = await Promise.allSettled([admin("/health"), admin("/ready"), updater("/status")]);
    const value = (result: PromiseSettledResult<Upstream>) =>
      result.status === "fulfilled"
        ? { ok: result.value.status < 400, body: result.value.body }
        : { ok: false, body: { error: String((result.reason as Error)?.message ?? result.reason) } };
    return { health: value(health), ready: value(ready), updater: value(update) };
  });

  app.get("/api/top", async (request, reply) => {
    const decision = (request.query as { decision?: string }).decision;
    if (decision !== "block" && decision !== "allow") return badRequest(reply);
    return relay(reply, await admin(`/admin/top?decision=${decision}`));
  });

  // ---- Domains -----------------------------------------------------------

  app.get("/api/domains", async (request, reply) => {
    const page = Math.max(0, Math.floor(Number((request.query as { page?: string }).page ?? 0)) || 0);
    const result = await admin(`/admin/domains?limit=${DOMAINS_PAGE_SIZE}&offset=${page * DOMAINS_PAGE_SIZE}`);
    if (result.status >= 400) return relay(reply, result);
    const total = Number(result.body.total ?? 0);
    return {
      items: result.body.items ?? [],
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / DOMAINS_PAGE_SIZE)),
    };
  });

  app.post("/api/domains/rule", async (request, reply) => {
    const { action, key } = (request.body ?? {}) as { action?: string; key?: string };
    if (!["default", "allow", "block"].includes(String(action)) || !domainKey.test(String(key))) return badRequest(reply);
    return relay(reply, await admin("/admin/rules/by-key", { method: "POST", body: { action, key } }));
  });

  // ---- Blocklists --------------------------------------------------------

  app.get("/api/lists", async (_request, reply) => relay(reply, await admin("/admin/lists")));

  app.post("/api/lists", async (request, reply) => {
    const { url } = (request.body ?? {}) as { url?: unknown };
    if (typeof url !== "string" || !url.trim()) return badRequest(reply, "URL required");
    return relay(reply, await admin("/admin/lists", { method: "POST", body: { url: url.trim() } }));
  });

  app.post("/api/lists/refresh", async (_request, reply) =>
    relay(reply, await admin("/admin/lists/refresh", { method: "POST", body: {} })));

  app.post("/api/lists/:id/enabled", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { enabled } = (request.body ?? {}) as { enabled?: unknown };
    if (!listId.test(id) || typeof enabled !== "boolean") return badRequest(reply);
    return relay(reply, await admin(`/admin/lists/${id}/enabled`, { method: "POST", body: { enabled } }));
  });

  app.post("/api/lists/:id/refresh", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!listId.test(id)) return badRequest(reply);
    return relay(reply, await admin(`/admin/lists/${id}/refresh`, { method: "POST", body: {} }));
  });

  app.delete("/api/lists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!listId.test(id)) return badRequest(reply);
    return relay(reply, await admin(`/admin/lists/${id}`, { method: "DELETE" }));
  });

  // ---- VPN users ---------------------------------------------------------

  app.get("/api/vpn/peers", async (_request, reply) => relay(reply, await updater("/vpn/peers")));

  app.post("/api/vpn/peers", async (request, reply) => {
    const { name } = (request.body ?? {}) as { name?: unknown };
    if (typeof name !== "string" || !peerName.test(name)) return badRequest(reply, "Use 1-32 letters, numbers, _ or -");
    return relay(reply, await updater("/vpn/peers", { method: "POST", body: { name } }));
  });

  app.post("/api/vpn/peers/:name/:action", async (request, reply) => {
    const { name, action } = request.params as { name: string; action: string };
    if (!peerName.test(name) || !["enable", "disable", "rotate"].includes(action)) return badRequest(reply);
    return relay(reply, await updater(`/vpn/peers/${name}/${action}`, { method: "POST", body: {} }));
  });

  app.delete("/api/vpn/peers/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!peerName.test(name)) return badRequest(reply);
    return relay(reply, await updater(`/vpn/peers/${name}`, { method: "DELETE" }));
  });

  app.get("/api/vpn/peers/:name/config", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!peerName.test(name)) return badRequest(reply);
    const result = await updater(`/vpn/peers/${name}/config`);
    if (result.status >= 400) return relay(reply, result);
    return reply
      .type("text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}.conf"`)
      .send(String(result.body.config ?? ""));
  });

  app.get("/api/vpn/peers/:name/qr", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!peerName.test(name)) return badRequest(reply);
    const result = await updater(`/vpn/peers/${name}/qr`);
    if (result.status >= 400) return relay(reply, result);
    return reply.type("image/png").send(Buffer.from(String(result.body.pngBase64 ?? ""), "base64"));
  });

  // ---- LAN access --------------------------------------------------------

  async function lanView(name: string, acl: LanAcl) {
    const lan = await updater("/lan");
    const inventory = lan.status < 400 ? lan.body.inventory ?? null : null;
    return {
      acl,
      summary: lanSummary(acl),
      network: inventory ? { target: inventory.target, scannedAt: inventory.scannedAt, hosts: inventory.hosts.length } : null,
      scan: lan.status < 400 ? lan.body.scan ?? { running: false, error: null } : { running: false, error: "LAN inventory unavailable" },
      devices: lanDevices(acl, inventory),
      name,
    };
  }

  app.get("/api/vpn/peers/:name/lan", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!peerName.test(name)) return badRequest(reply);
    const acl = await updater(`/vpn/peers/${name}/lan`);
    if (acl.status >= 400) return relay(reply, acl);
    return lanView(name, acl.body);
  });

  app.post("/api/vpn/peers/:name/lan", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!peerName.test(name)) return badRequest(reply);
    const current = await updater(`/vpn/peers/${name}/lan`);
    if (current.status >= 400) return relay(reply, current);

    const next = applyLanChange(current.body, (request.body ?? {}) as LanChange);
    if (!next) return badRequest(reply, "Invalid LAN rule: use a private address like 192.168.1.50, 192.168.1.50:8123 or 192.168.1.50 udp 1900");

    const saved = await updater(`/vpn/peers/${name}/lan`, {
      method: "PUT",
      body: next.mode === "full" ? { mode: "full" } : { mode: "custom", rules: next.rules },
    });
    if (saved.status >= 400) return relay(reply, saved);
    return lanView(name, saved.body);
  });

  app.post("/api/lan/scan", async (_request, reply) => relay(reply, await updater("/lan/scan", { method: "POST", body: {} })));

  // ---- HTTPS integrations ------------------------------------------------

  app.get("/api/integrations", async (_request, reply) => relay(reply, await updater("/integrations")));

  app.post("/api/integrations/:id/actions/:action", async (request, reply) => {
    const { id, action } = request.params as { id: string; action: string };
    if (!integrationPart.test(id) || !integrationPart.test(action)) return badRequest(reply);
    return relay(reply, await updater(`/integrations/${id}/actions/${action}`, { method: "POST", body: {} }));
  });

  // ---- System ------------------------------------------------------------

  app.post("/api/reload", async (_request, reply) => relay(reply, await admin("/admin/reload", { method: "POST", body: {} })));
  app.post("/api/update", async (_request, reply) => relay(reply, await updater("/update", { method: "POST", body: {} })));
  app.get("/api/update/status", async (_request, reply) => relay(reply, await updater("/status")));

  return app;
}
