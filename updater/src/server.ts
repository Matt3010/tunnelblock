import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import { parseDiscoveryOutput, validLanRule, type LanInventory } from "./lan-discovery.js";

const execFileAsync = promisify(execFile);
const app = Fastify({ logger: true });

const token = process.env.ADMIN_API_TOKEN;
const repoDir = process.env.REPO_DIR ?? "/workspace";
const listRefreshIntervalHours = Number(process.env.LIST_REFRESH_INTERVAL_HOURS ?? 24);
const lanScanIntervalHours = Number(process.env.LAN_SCAN_INTERVAL_HOURS ?? 12);
const runtimeStartedAt = new Date().toISOString();

function safeProcessError(error: unknown): {
  code: string | number | null;
  signal: string | null;
  stderr: string;
} {
  const failure = error as {
    code?: string | number;
    signal?: string;
    stderr?: string;
  };

  return {
    code: failure?.code ?? null,
    signal: failure?.signal ?? null,
    stderr: typeof failure?.stderr === "string"
      ? tail(failure.stderr, 2000)
      : "",
  };
}

function tail(value: string, max = 12000): string {
  return value.length <= max ? value : value.slice(-max);
}

function authorized(request: any, reply: any): boolean {
  if (!token) {
    reply.code(503).send({ error: "ADMIN_API_TOKEN not configured" });
    return false;
  }

  if (request.headers.authorization !== `Bearer ${token}`) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }

  return true;
}

async function localSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", `safe.directory=${repoDir}`, "rev-parse", "HEAD"], {
    cwd: repoDir,
    env: process.env,
  });
  return stdout.trim();
}

function validPeerName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

async function wireguardPeerCommand(action: string, name?: string, extra: string[] = []): Promise<string> {
  const args = ["compose", "exec", "-T", "wireguard", "/app/peer-manager.sh", action];
  if (name) args.push(name, ...extra);
  const { stdout } = await execFileAsync("docker", args, { cwd: repoDir, env: process.env });
  return stdout;
}

const lanInventoryFile = process.env.LAN_INVENTORY_FILE ?? "/updater-data/lan-inventory.json";

type LanScanState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

const lanScan: LanScanState = { running: false, startedAt: null, finishedAt: null, error: null };

function loadLanInventory(): LanInventory | null {
  try {
    return JSON.parse(fs.readFileSync(lanInventoryFile, "utf8")) as LanInventory;
  } catch {
    return null;
  }
}

async function runLanScan(): Promise<void> {
  lanScan.running = true;
  lanScan.startedAt = new Date().toISOString();
  lanScan.error = null;
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "--profile", "tools", "run", "--rm", "--no-deps", "-T", "lan-discovery"],
      { cwd: repoDir, env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 },
    );
    const inventory = parseDiscoveryOutput(stdout);
    fs.mkdirSync(path.dirname(lanInventoryFile), { recursive: true });
    const tmp = `${lanInventoryFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(inventory, null, 2) + "\n");
    fs.renameSync(tmp, lanInventoryFile);
    app.log.info({ hosts: inventory.hosts.length, target: inventory.target }, "lan-scan-complete");
  } catch (error) {
    const safe = safeProcessError(error);
    lanScan.error = safe.stderr.trim().split("\n").pop() || "LAN discovery failed";
    app.log.error({ error: safe }, "lan-scan-failed");
  } finally {
    lanScan.running = false;
    lanScan.finishedAt = new Date().toISOString();
  }
}

function startLanScan(): boolean {
  if (lanScan.running) return false;
  void runLanScan();
  return true;
}

async function serviceRuntimeState(service: string): Promise<string> {
  try {
    const { stdout: idOutput } = await execFileAsync(
      "docker",
      ["compose", "ps", "-q", "--all", service],
      { cwd: repoDir, env: process.env },
    );
    const containerId = idOutput.trim();
    if (!containerId) return "missing";

    const { stdout: stateOutput } = await execFileAsync(
      "docker",
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        containerId,
      ],
      { cwd: repoDir, env: process.env },
    );

    return stateOutput.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function refreshExternalBlocklists(): Promise<void> {
  if (!token) return;

  try {
    const response = await fetch("http://doh-a:8053/admin/lists/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "{}",
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Blocklist refresh failed: HTTP ${response.status} ${responseText}`,
      );
    }

    app.log.info({ result: responseText }, "external-blocklists-refreshed");
  } catch (error) {
    app.log.error({ error }, "external-blocklist-refresh-failed");
  }
}

app.get("/health", async () => ({ ok: true }));

app.get("/status", async (request, reply) => {
  if (!authorized(request, reply)) return;

  let currentSha: string | null = null;
  try {
    currentSha = await localSha();
  } catch {}

  const [dohA, dohB, web, proxy, wireguard] = await Promise.all([
    serviceRuntimeState("doh-a"),
    serviceRuntimeState("doh-b"),
    serviceRuntimeState("web"),
    serviceRuntimeState("proxy"),
    serviceRuntimeState("wireguard"),
  ]);

  return {
    runtimeStartedAt,
    currentSha,
    services: { dohA, dohB, web, proxy, wireguard },
  };
});

app.get("/vpn/peers", async (request, reply) => {
  if (!authorized(request, reply)) return;
  return JSON.parse(await wireguardPeerCommand("list"));
});

app.post("/vpn/peers", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const name = (request.body as { name?: unknown } | null)?.name;
  if (!validPeerName(name)) return reply.code(400).send({ error: "invalid peer name" });
  return JSON.parse(await wireguardPeerCommand("add", name));
});

app.post("/vpn/peers/:name/:action", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const { name, action } = request.params as { name: string; action: string };
  if (!validPeerName(name) || !["enable", "disable", "rotate"].includes(action)) {
    return reply.code(400).send({ error: "invalid peer operation" });
  }
  return JSON.parse(await wireguardPeerCommand(action, name));
});

app.delete("/vpn/peers/:name", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const { name } = request.params as { name: string };
  if (!validPeerName(name)) return reply.code(400).send({ error: "invalid peer name" });
  return JSON.parse(await wireguardPeerCommand("delete", name));
});

app.get("/vpn/peers/:name/config", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const { name } = request.params as { name: string };
  if (!validPeerName(name)) return reply.code(400).send({ error: "invalid peer name" });
  return { name, config: await wireguardPeerCommand("conf", name) };
});

app.get("/vpn/peers/:name/qr", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const { name } = request.params as { name: string };
  if (!validPeerName(name)) return reply.code(400).send({ error: "invalid peer name" });
  const args = ["compose", "exec", "-T", "wireguard", "/app/peer-manager.sh", "png", name];
  const { stdout } = await execFileAsync("docker", args, {
    cwd: repoDir,
    env: process.env,
    encoding: "buffer",
    maxBuffer: 2 * 1024 * 1024,
  });
  return { name, pngBase64: stdout.toString("base64") };
});

app.get("/vpn/peers/:name/lan", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const { name } = request.params as { name: string };
  if (!validPeerName(name)) return reply.code(400).send({ error: "invalid peer name" });
  return JSON.parse(await wireguardPeerCommand("lan-get", name));
});

app.put("/vpn/peers/:name/lan", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const { name } = request.params as { name: string };
  if (!validPeerName(name)) return reply.code(400).send({ error: "invalid peer name" });
  const body = (request.body ?? {}) as { mode?: unknown; rules?: unknown };
  if (body.mode === "full") return JSON.parse(await wireguardPeerCommand("lan-set", name, ["full"]));
  if (body.mode !== "custom" || !Array.isArray(body.rules)) {
    return reply.code(400).send({ error: "expected {mode:'full'} or {mode:'custom', rules:[...]}" });
  }
  const rules = [...new Set(body.rules)];
  if (rules.length > 128 || !rules.every(validLanRule)) {
    return reply.code(400).send({ error: "invalid LAN rule (private IPv4 as IP/any, IP/tcp/PORT or IP/udp/PORT)" });
  }
  return JSON.parse(await wireguardPeerCommand("lan-set", name, rules as string[]));
});

app.get("/lan", async (request, reply) => {
  if (!authorized(request, reply)) return;
  return { inventory: loadLanInventory(), scan: lanScan };
});

app.post("/lan/scan", async (request, reply) => {
  if (!authorized(request, reply)) return;
  if (lanScan.running) return reply.code(202).send({ started: false, scan: lanScan });
  startLanScan();
  return reply.code(202).send({ started: true, scan: lanScan });
});

await app.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 8090),
});

setTimeout(() => void refreshExternalBlocklists(), 60_000);
setTimeout(() => { if (!loadLanInventory()) startLanScan(); }, 90_000);

setInterval(
  () => void refreshExternalBlocklists(),
  listRefreshIntervalHours * 60 * 60 * 1000,
);
if (lanScanIntervalHours > 0) {
  setInterval(() => void startLanScan(), lanScanIntervalHours * 60 * 60 * 1000);
}
