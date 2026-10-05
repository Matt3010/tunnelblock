import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";

const PASSWORD = "a long test password";
const LAN = "192.168.1.30";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
type Reply = { status?: number; body: unknown };

function fakeUpstream(routes: Record<string, Reply | ((call: Call) => Reply)>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.url}`];
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const reply = typeof route === "function" ? route(call) : route;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function publicDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-web-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>TunnelBlock</title>");
  fs.writeFileSync(path.join(dir, "app.js"), "console.log('ok')");
  return dir;
}

function makeApp(routes: Record<string, Reply | ((call: Call) => Reply)> = {}, trustProxy = false) {
  const upstream = fakeUpstream(routes);
  const app = buildApp({
    trustProxy,
    user: "admin",
    password: PASSWORD,
    adminToken: "secret-token",
    adminBase: "http://admin",
    updaterBase: "http://updater",
    publicDir: publicDir(),
    fetchImpl: upstream.fetchImpl,
  });
  return { app, calls: upstream.calls };
}

const AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;

test("behind the HTTPS proxy, lockouts apply to the real client, not the proxy", async () => {
  const { app } = makeApp({}, true);
  const proxy = "172.20.0.9";
  const wrong = `Basic ${Buffer.from("admin:nope").toString("base64")}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await app.inject({ method: "GET", url: "/", remoteAddress: proxy, headers: { authorization: wrong, "x-forwarded-for": "203.0.113.7" } });
  }
  const attacker = await app.inject({ method: "GET", url: "/", remoteAddress: proxy, headers: { authorization: AUTH, "x-forwarded-for": "203.0.113.7" } });
  assert.equal(attacker.statusCode, 429);

  const owner = await app.inject({ method: "GET", url: "/", remoteAddress: proxy, headers: { authorization: AUTH, "x-forwarded-for": "198.51.100.4" } });
  assert.equal(owner.statusCode, 200);
});

test("asks the browser for Basic credentials on every path", async () => {
  const { app, calls } = makeApp({ "GET http://admin/admin/status": { body: { ok: true } } });
  for (const url of ["/", "/app.js", "/api/status"]) {
    const res = await app.inject({ method: "GET", url, remoteAddress: LAN });
    assert.equal(res.statusCode, 401, url);
    assert.equal(res.headers["www-authenticate"], 'Basic realm="TunnelBlock", charset="UTF-8"');
  }
  const wrong = await app.inject({
    method: "GET",
    url: "/api/status",
    remoteAddress: LAN,
    headers: { authorization: `Basic ${Buffer.from("admin:nope").toString("base64")}` },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("serves the page with strict security headers", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/", remoteAddress: LAN, headers: { authorization: AUTH } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
  assert.match(res.headers["content-security-policy"] as string, /default-src 'self'/);
  assert.match(res.headers["content-security-policy"] as string, /frame-ancestors 'none'/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["cache-control"], "no-store");

  const script = await app.inject({ method: "GET", url: "/app.js", remoteAddress: LAN, headers: { authorization: AUTH } });
  assert.match(script.headers["content-type"] as string, /javascript/);

  const traversal = await app.inject({ method: "GET", url: "/..%2Fpackage.json", remoteAddress: LAN, headers: { authorization: AUTH } });
  assert.equal(traversal.statusCode, 404);
});

test("locks out a source after five wrong passwords, even if the sixth is right", async () => {
  const { app } = makeApp();
  const wrong = `Basic ${Buffer.from("admin:nope").toString("base64")}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await app.inject({ method: "GET", url: "/", remoteAddress: LAN, headers: { authorization: wrong } });
  }
  const res = await app.inject({ method: "GET", url: "/", remoteAddress: LAN, headers: { authorization: AUTH } });
  assert.equal(res.statusCode, 429);

  const other = await app.inject({ method: "GET", url: "/", remoteAddress: "192.168.1.31", headers: { authorization: AUTH } });
  assert.equal(other.statusCode, 200);
});

test("credential-less requests from the browser do not count as failed logins", async () => {
  const { app } = makeApp();
  for (let attempt = 0; attempt < 10; attempt++) {
    await app.inject({ method: "GET", url: "/", remoteAddress: LAN });
  }
  const res = await app.inject({ method: "GET", url: "/", remoteAddress: LAN, headers: { authorization: AUTH } });
  assert.equal(res.statusCode, 200);
});

test("rejects cross-site writes", async () => {
  const { app, calls } = makeApp({ "POST http://admin/admin/reload": { body: { ok: true } } });
  const headers = { authorization: AUTH };
  const res = await app.inject({
    method: "POST",
    url: "/api/reload",
    remoteAddress: LAN,
    headers: { ...headers, origin: "http://evil.example", host: "192.168.1.5:8080" },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);

  const same = await app.inject({
    method: "POST",
    url: "/api/reload",
    remoteAddress: LAN,
    headers: { ...headers, origin: "http://192.168.1.5:8080", host: "192.168.1.5:8080" },
    payload: {},
  });
  assert.equal(same.statusCode, 200);
});

test("proxies to the admin API with the server-side token", async () => {
  const { app, calls } = makeApp({ "GET http://admin/admin/status": { body: { ok: true, queries: 12 } } });
  const headers = { authorization: AUTH };
  const res = await app.inject({ method: "GET", url: "/api/status", remoteAddress: LAN, headers });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, queries: 12 });
  assert.equal(calls[0].headers.authorization, "Bearer secret-token");
});

test("relays upstream client errors", async () => {
  const { app } = makeApp({ "POST http://admin/admin/lists": { status: 400, body: { error: "url must use https" } } });
  const headers = { authorization: AUTH };
  const res = await app.inject({ method: "POST", url: "/api/lists", remoteAddress: LAN, headers, payload: { url: "http://x" } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: "url must use https" });
});

test("pages observed domains", async () => {
  const { app } = makeApp({
    "GET http://admin/admin/domains?limit=20&offset=40": { body: { total: 45, items: [{ key: "a", domain: "x.com" }] } },
  });
  const headers = { authorization: AUTH };
  const res = await app.inject({ method: "GET", url: "/api/domains?page=2", remoteAddress: LAN, headers });
  assert.deepEqual(res.json(), { items: [{ key: "a", domain: "x.com" }], total: 45, page: 2, pageCount: 3 });
});

test("changes a domain rule by key", async () => {
  const { app, calls } = makeApp({ "POST http://admin/admin/rules/by-key": { body: { domain: "x.com", state: "block" } } });
  const headers = { authorization: AUTH };
  const res = await app.inject({
    method: "POST",
    url: "/api/domains/rule",
    remoteAddress: LAN,
    headers,
    payload: { action: "block", key: "0123456789abcdef" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.at(-1)?.body, { action: "block", key: "0123456789abcdef" });

  const bad = await app.inject({
    method: "POST",
    url: "/api/domains/rule",
    remoteAddress: LAN,
    headers,
    payload: { action: "nuke", key: "0123456789abcdef" },
  });
  assert.equal(bad.statusCode, 400);
});

test("validates VPN user names before calling the updater", async () => {
  const { app, calls } = makeApp();
  const headers = { authorization: AUTH };
  const res = await app.inject({ method: "POST", url: "/api/vpn/peers/..%2Fx/enable", remoteAddress: LAN, headers, payload: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("manages VPN users", async () => {
  const { app, calls } = makeApp({
    "POST http://updater/vpn/peers/alice/disable": { body: { ok: true } },
    "POST http://updater/vpn/peers/alice/rotate": { body: { ok: true } },
    "DELETE http://updater/vpn/peers/alice": { body: { ok: true } },
    "POST http://updater/vpn/peers": call => ({ body: { name: (call.body as any).name } }),
  });
  const headers = { authorization: AUTH };

  for (const action of ["disable", "rotate"]) {
    const res = await app.inject({ method: "POST", url: `/api/vpn/peers/alice/${action}`, remoteAddress: LAN, headers, payload: {} });
    assert.equal(res.statusCode, 200, action);
  }
  const removed = await app.inject({ method: "DELETE", url: "/api/vpn/peers/alice", remoteAddress: LAN, headers });
  assert.equal(removed.statusCode, 200);

  const created = await app.inject({ method: "POST", url: "/api/vpn/peers", remoteAddress: LAN, headers, payload: { name: "bob" } });
  assert.deepEqual(created.json(), { name: "bob" });
  assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [
    "POST http://updater/vpn/peers/alice/disable",
    "POST http://updater/vpn/peers/alice/rotate",
    "DELETE http://updater/vpn/peers/alice",
    "POST http://updater/vpn/peers",
  ]);
});

test("downloads a VPN configuration and shows its QR code", async () => {
  const { app } = makeApp({
    "GET http://updater/vpn/peers/alice/config": { body: { config: "[Interface]\nPrivateKey = x\n" } },
    "GET http://updater/vpn/peers/alice/qr": { body: { pngBase64: Buffer.from("PNG").toString("base64") } },
  });
  const headers = { authorization: AUTH };

  const config = await app.inject({ method: "GET", url: "/api/vpn/peers/alice/config", remoteAddress: LAN, headers });
  assert.equal(config.body, "[Interface]\nPrivateKey = x\n");
  assert.match(config.headers["content-disposition"] as string, /attachment; filename="alice.conf"/);
  assert.equal(config.headers["cache-control"], "no-store");

  const qr = await app.inject({ method: "GET", url: "/api/vpn/peers/alice/qr", remoteAddress: LAN, headers });
  assert.equal(qr.headers["content-type"], "image/png");
  assert.equal(qr.body, "PNG");
});

test("describes and changes a user's LAN access", async () => {
  let stored = { mode: "custom", rules: ["192.168.1.20/tcp/22"] };
  const { app, calls } = makeApp({
    "GET http://updater/vpn/peers/alice/lan": () => ({ body: stored }),
    "PUT http://updater/vpn/peers/alice/lan": call => {
      stored = { mode: (call.body as any).mode, rules: (call.body as any).rules ?? [] };
      return { body: stored };
    },
    "GET http://updater/lan": {
      body: {
        inventory: {
          scannedAt: "2026-09-29T10:00:00.000Z",
          interface: "eth0",
          target: "192.168.1.5/24",
          hosts: [{ ip: "192.168.1.20", hostname: "nas", vendor: null, ports: [{ protocol: "tcp", port: 22, service: "ssh" }, { protocol: "tcp", port: 80, service: "http" }] }],
        },
        scan: { running: false, error: null },
      },
    },
  });
  const headers = { authorization: AUTH };

  const view = await app.inject({ method: "GET", url: "/api/vpn/peers/alice/lan", remoteAddress: LAN, headers });
  const body = view.json();
  assert.equal(body.summary, "1 device · 1 rule");
  assert.equal(body.network.target, "192.168.1.5/24");
  assert.deepEqual(body.devices[0].ports.map((port: any) => port.allowed), [true, false]);

  const changed = await app.inject({
    method: "POST",
    url: "/api/vpn/peers/alice/lan",
    remoteAddress: LAN,
    headers,
    payload: { kind: "port", ip: "192.168.1.20", protocol: "tcp", port: 80 },
  });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(calls.find(call => call.method === "PUT")?.body, { mode: "custom", rules: ["192.168.1.20/tcp/22", "192.168.1.20/tcp/80"] });
  assert.deepEqual(changed.json().devices[0].ports.map((port: any) => port.allowed), [true, true]);

  const invalid = await app.inject({
    method: "POST",
    url: "/api/vpn/peers/alice/lan",
    remoteAddress: LAN,
    headers,
    payload: { kind: "manual", text: "8.8.8.8" },
  });
  assert.equal(invalid.statusCode, 400);
});
