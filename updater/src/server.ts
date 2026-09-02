import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";
import Fastify from "fastify";
import { runtimeNeedsDeployment } from "./revision.js";
import { loadHttpsRegistry, summarizeHttpsObservation, validIntegrationAction, type HttpsIntegration } from "./https-integrations.js";

const execFileAsync = promisify(execFile);
const app = Fastify({ logger: true });

const token = process.env.ADMIN_API_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const repoDir = process.env.REPO_DIR ?? "/workspace";
const branch = process.env.GIT_BRANCH ?? "master";
const composeProjectName = process.env.COMPOSE_PROJECT_NAME ?? "adblock-general-purpose";
const updaterDataVolume =
  process.env.UPDATER_DATA_VOLUME ?? "adblock-general-purpose-updater-data";
const pollIntervalSec = Number(process.env.AUTO_UPDATE_INTERVAL_SEC ?? 300);
const listRefreshIntervalHours = Number(process.env.LIST_REFRESH_INTERVAL_HOURS ?? 24);
const runtimeGeneration = process.env.UPDATER_RUNTIME_GENERATION ?? "unknown";
const runtimeBuildSha = process.env.UPDATER_BUILD_SHA ?? "unknown";
const runtimeStartedAt = new Date().toISOString();
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const updaterStateFile = process.env.UPDATER_STATE_FILE ?? "/updater-data/state.json";
const updaterLogFile = process.env.UPDATER_LOG_FILE ?? "/updater-data/deploy.log";
const helperName = "adblock-general-purpose-deploy-helper";

type UpdateState = {
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccess: boolean | null;
  lastOutput: string;
  lastSeenRemoteSha: string | null;
  failedRemoteSha: string | null;
};

let launching = false;
let lastAutomaticCheckAt: string | null = null;
let lastAutomaticCheckError: string | null = null;

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
          .replace(/github_pat_[A-Za-z0-9_]+/g, "<redacted>")
          .replace(/Authorization:\s*Basic\s+\S+/gi, "Authorization: Basic <redacted>")
      : "",
  };
}

function defaultState(): UpdateState {
  return {
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccess: null,
    lastOutput: "No update has run yet.",
    lastSeenRemoteSha: null,
    failedRemoteSha: null,
  };
}

function loadUpdateState(): UpdateState {
  try {
    const parsed = JSON.parse(fs.readFileSync(updaterStateFile, "utf8")) as Partial<UpdateState>;
    return {
      running: Boolean(parsed.running),
      lastStartedAt: typeof parsed.lastStartedAt === "string" ? parsed.lastStartedAt : null,
      lastFinishedAt: typeof parsed.lastFinishedAt === "string" ? parsed.lastFinishedAt : null,
      lastSuccess: typeof parsed.lastSuccess === "boolean" ? parsed.lastSuccess : null,
      lastOutput:
        typeof parsed.lastOutput === "string"
          ? parsed.lastOutput
          : "No update has run yet.",
      lastSeenRemoteSha:
        typeof parsed.lastSeenRemoteSha === "string" ? parsed.lastSeenRemoteSha : null,
      failedRemoteSha:
        typeof parsed.failedRemoteSha === "string" ? parsed.failedRemoteSha : null,
    };
  } catch {
    return defaultState();
  }
}

function persistUpdateState(state: UpdateState): void {
  fs.mkdirSync(path.dirname(updaterStateFile), { recursive: true });
  const tmp = `${updaterStateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, updaterStateFile);
}

function tail(value: string, max = 12000): string {
  return value.length <= max ? value : value.slice(-max);
}

function liveUpdateState(): UpdateState {
  const state = loadUpdateState();

  try {
    const liveOutput = fs.readFileSync(updaterLogFile, "utf8");
    if (liveOutput) state.lastOutput = tail(liveOutput);
  } catch {}

  return state;
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

async function notifyTelegram(message: string): Promise<void> {
  if (!telegramToken || telegramUserIds.length === 0) return;

  for (const chatId of telegramUserIds) {
    try {
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
        }),
      });
    } catch (error) {
      app.log.error({ error, chatId }, "telegram-notification-failed");
    }
  }
}

function githubAuthHeader(): string {
  if (!githubToken) throw new Error("GITHUB_TOKEN is not configured");
  return Buffer.from(`x-access-token:${githubToken}`).toString("base64");
}

async function fetchRemoteSha(): Promise<string> {
  const auth = githubAuthHeader();
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      `safe.directory=${repoDir}`,
      "-c",
      "credential.helper=",
      "ls-remote",
      "origin",
      `refs/heads/${branch}`,
    ],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
      },
    },
  );

  const sha = stdout.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/i.test(sha ?? "")) {
    throw new Error("Unable to resolve remote branch SHA");
  }

  return sha;
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

async function wireguardPeerCommand(action: string, name?: string): Promise<string> {
  const args = ["compose", "exec", "-T", "wireguard", "/app/peer-manager.sh", action];
  if (name) args.push(name);
  const { stdout } = await execFileAsync("docker", args, { cwd: repoDir, env: process.env });
  return stdout;
}


type HttpsRuntimeState = {
  active: boolean;
  integration: string | null;
  mode: string;
  startedAt: string | null;
};

const httpsRegistryPath = path.join(repoDir, "https", "integrations.json");
const httpsRuntimeStateFile = path.join(repoDir, "data", "https", "runtime-state.json");
const httpsPublicCaFile = path.join(
  repoDir,
  "data",
  "https",
  "public",
  "adblock-general-purpose-ca.cer",
);
let caPreparation: Promise<void> | null = null;

async function ensureHttpsCa(): Promise<void> {
  if (fs.existsSync(httpsPublicCaFile)) return;
  if (!caPreparation) {
    caPreparation = runHttpsScript("scripts/https-ca.sh", ["prepare"])
      .then(() => undefined)
      .finally(() => { caPreparation = null; });
  }
  await caPreparation;
}

function loadHttpsIntegrations(): HttpsIntegration[] {
  return loadHttpsRegistry(httpsRegistryPath);
}

function getHttpsIntegration(id: string): HttpsIntegration | undefined {
  return loadHttpsIntegrations().find(item => item.id === id);
}

function defaultHttpsRuntimeState(): HttpsRuntimeState {
  return {
    active: false,
    integration: null,
    mode: "disabled",
    startedAt: null,
  };
}

function loadHttpsRuntimeState(): HttpsRuntimeState {
  try {
    const parsed = JSON.parse(fs.readFileSync(httpsRuntimeStateFile, "utf8")) as Partial<HttpsRuntimeState>;
    return {
      active: parsed.active === true,
      integration: typeof parsed.integration === "string" ? parsed.integration : null,
      mode: typeof parsed.mode === "string" ? parsed.mode : "disabled",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
    };
  } catch {
    return defaultHttpsRuntimeState();
  }
}

async function runHttpsScript(script: string, args: string[] = []): Promise<string> {
  const hostRepoDir = await resolveHostRepoDir();
  const { stdout } = await execFileAsync("sh", [script, ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      HOST_REPO_DIR: hostRepoDir,
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function httpsFirewallStatus(kind: "interception" | "quic"): Promise<string> {
  try {
    const action = kind === "interception" ? "status" : "status";
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "exec", "-T", "wireguard", "/app/https-firewall.sh", kind, action],
      { cwd: repoDir, env: process.env },
    );
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function httpsObservationInfo(id: string): { bytes: number; modifiedAt: string | null } {
  const log = path.join(repoDir, "data", "https", "observations", `${id}.jsonl`);
  try {
    const stat = fs.statSync(log);
    return { bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch {
    return { bytes: 0, modifiedAt: null };
  }
}

function httpsSummary(id: string) {
  const log = path.join(repoDir, "data", "https", "observations", `${id}.jsonl`);
  try { return summarizeHttpsObservation(fs.readFileSync(log, "utf8")); }
  catch { return summarizeHttpsObservation(""); }
}

async function httpsOverview() {
  const declared = loadHttpsRuntimeState();
  const [proxyState, interception, quic] = await Promise.all([
    httpsProxyRuntimeState(),
    httpsFirewallStatus("interception"),
    httpsFirewallStatus("quic"),
  ]);

  const liveActive =
    declared.active
    && proxyState === "healthy"
    && interception === "enabled";

  return {
    active: liveActive,
    integration: liveActive ? declared.integration : null,
    mode: liveActive ? declared.mode : "disabled",
    startedAt: liveActive ? declared.startedAt : null,
    staleState: declared.active && !liveActive,
    proxyState,
    interception,
    quic,
    caReady: fs.existsSync(httpsPublicCaFile),
  };
}

async function httpsProxyRuntimeState(): Promise<string> {
  try {
    const { stdout: idOutput } = await execFileAsync(
      "docker",
      ["compose", "--profile", "https-lab", "ps", "-q", "--all", "https-proxy"],
      { cwd: repoDir, env: process.env },
    );
    const containerId = idOutput.trim();
    if (!containerId) return "stopped";

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

async function resolveHostRepoDir(): Promise<string> {
  const { stdout: ids } = await execFileAsync(
    "docker",
    [
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${composeProjectName}`,
      "--filter",
      "label=com.docker.compose.service=updater",
    ],
    { env: process.env },
  );

  const containerId = ids.trim().split(/\s+/)[0];
  if (!containerId) throw new Error("Unable to locate running updater container");

  const { stdout } = await execFileAsync(
    "docker",
    [
      "inspect",
      "--format",
      '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}',
      containerId,
    ],
    { env: process.env },
  );

  const hostRepoDir = stdout.trim();
  if (!hostRepoDir) throw new Error("Unable to resolve host repository path");

  return hostRepoDir;
}

async function deploymentHelperExists(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-q", "--filter", `name=${helperName}`],
      { env: process.env },
    );
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function reconcileInterruptedDeployment(): Promise<void> {
  const state = loadUpdateState();
  if (!state.running) return;
  if (await deploymentHelperExists()) return;

  const startedAt = state.lastStartedAt ? Date.parse(state.lastStartedAt) : NaN;
  if (Number.isFinite(startedAt) && Date.now() - startedAt < 30_000) return;

  const finishedAt = new Date().toISOString();
  const failedState: UpdateState = {
    ...state,
    running: false,
    lastFinishedAt: finishedAt,
    lastSuccess: false,
    lastOutput: tail(
      state.lastOutput +
        "\nDeployment helper is no longer running; deployment marked interrupted.\n",
    ),
  };

  persistUpdateState(failedState);
  await notifyTelegram(
    "❌ TunnelBlock update interrupted: the deployment helper is no longer running.",
  );
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

async function launchDeployment(
  trigger: "manual" | "automatic",
): Promise<{ started: boolean; helperId?: string }> {
  if (launching) return { started: false };

  const currentState = loadUpdateState();
  if (currentState.running) return { started: false };
  if (!githubToken) throw new Error("GITHUB_TOKEN is not configured");

  launching = true;
  const startedAt = new Date().toISOString();

  persistUpdateState({
    ...currentState,
    running: true,
    lastStartedAt: startedAt,
    lastFinishedAt: null,
    lastSuccess: null,
    lastOutput: "Deployment helper starting...\n",
    failedRemoteSha: null,
  });

  try {
    const hostRepoDir = await resolveHostRepoDir();

    await execFileAsync("docker", ["rm", "-f", helperName], {
      env: process.env,
    }).catch(() => {});

    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-d",
        "--name",
        helperName,
        "-e",
        `HOST_REPO_DIR=${hostRepoDir}`,
        "-e",
        `GITHUB_TOKEN=${githubToken}`,
        "-e",
        `GIT_BRANCH=${branch}`,
        "-e",
        `COMPOSE_PROJECT_NAME=${composeProjectName}`,
        "-e",
        `UPDATER_STATE_FILE=${updaterStateFile}`,
        "-e",
        `UPDATER_LOG_FILE=${updaterLogFile}`,
        "-e",
        `DEPLOY_STARTED_AT=${startedAt}`,
        "-e",
        `TELEGRAM_BOT_TOKEN=${telegramToken ?? ""}`,
        "-e",
        `TELEGRAM_ALLOWED_USER_IDS=${telegramUserIds.join(",")}`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${hostRepoDir}:/workspace`,
        "-v",
        `${updaterDataVolume}:/updater-data`,
        "-w",
        "/workspace",
        "adblock-general-purpose-updater:latest",
        "/bootstrap-update.sh",
      ],
      {
        cwd: repoDir,
        env: process.env,
      },
    );

    const helperId = stdout.trim();

    persistUpdateState({
      ...loadUpdateState(),
      running: true,
      lastStartedAt: startedAt,
      lastFinishedAt: null,
      lastSuccess: null,
      lastOutput: `Deployment helper started: ${helperId}\n`,
      failedRemoteSha: null,
    });

    await notifyTelegram(
      trigger === "automatic"
        ? "🔄 New push to master detected. TunnelBlock update started."
        : "🔄 TunnelBlock update started.",
    );

    return { started: true, helperId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = loadUpdateState();

    persistUpdateState({
      ...state,
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastSuccess: false,
      lastOutput: tail(state.lastOutput + `\nUnable to start deployment helper: ${message}\n`),
    });

    await notifyTelegram(
      `❌ Unable to start the TunnelBlock update: ${message}`,
    );

    throw error;
  } finally {
    launching = false;
  }
}

async function checkForUpdates(): Promise<void> {
  if (launching) return;

  await reconcileInterruptedDeployment();
  const state = loadUpdateState();
  if (state.running) return;

  try {
    lastAutomaticCheckAt = new Date().toISOString();
    const remote = await fetchRemoteSha();
    const local = await localSha();
    lastAutomaticCheckError = null;

    if (remote === state.failedRemoteSha) {
      app.log.warn({ remote }, "skipping-previously-failed-revision");
      return;
    }

    if (remote !== local) {
      app.log.info({ local, remote }, "new-master-revision-detected");
      await launchDeployment("automatic");
      return;
    }

    if (runtimeNeedsDeployment(remote, runtimeBuildSha)) {
      app.log.info(
        { remote, runtimeBuildSha },
        "stale-runtime-revision-detected",
      );
      await launchDeployment("automatic");
      return;
    }

    if (state.lastSeenRemoteSha !== remote) {
      persistUpdateState({
        ...state,
        lastSeenRemoteSha: remote,
      });
    }
  } catch (error) {
    const safeError = safeProcessError(error);
    lastAutomaticCheckError = safeError.stderr || `git check failed (${safeError.code ?? "unknown"})`;
    app.log.error(safeError, "automatic-update-check-failed");
  }
}

app.get("/health", async () => ({
  ok: true,
  runtimeGeneration,
  runtimeBuildSha,
}));

app.get("/status", async (request, reply) => {
  if (!authorized(request, reply)) return;

  await reconcileInterruptedDeployment();

  let currentSha: string | null = null;
  try {
    currentSha = await localSha();
  } catch {}

  const [dohA, dohB, telegram, wireguard, httpsProxy] = await Promise.all([
    serviceRuntimeState("doh-a"),
    serviceRuntimeState("doh-b"),
    serviceRuntimeState("telegram-bot"),
    serviceRuntimeState("wireguard"),
    httpsProxyRuntimeState(),
  ]);

  const state = liveUpdateState();

  return {
    ...state,
    autoUpdate: true,
    githubAuthConfigured: Boolean(githubToken),
    pollIntervalSec,
    lastAutomaticCheckAt,
    lastAutomaticCheckError,
    statePersistent: true,
    runtimeGeneration,
    runtimeBuildSha,
    runtimeStartedAt,
    currentSha,
    services: {
      dohA,
      dohB,
      telegram,
      wireguard,
      httpsProxy,
    },
  };
});

app.post("/update", async (request, reply) => {
  if (!authorized(request, reply)) return;

  const state = loadUpdateState();
  if (state.running || launching) {
    return reply.code(409).send({ error: "update already running" });
  }

  try {
    const result = await launchDeployment("manual");
    if (!result.started) {
      return reply.code(409).send({ error: "update already running" });
    }

    return reply.code(202).send({
      ok: true,
      started: true,
      helperId: result.helperId,
    });
  } catch (error) {
    return reply.code(500).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/https/integrations", async (request, reply) => {
  if (!authorized(request, reply)) return;

  const runtime = await httpsOverview();
  return {
    items: loadHttpsIntegrations().map(item => ({
      ...item,
      observation: httpsObservationInfo(item.id),
    })),
    runtime,
  };
});

app.get("/integrations", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const runtime = await httpsOverview();
  return { items: loadHttpsIntegrations().map(item => ({ ...item, observation: httpsObservationInfo(item.id) })), runtime };
});

app.get("/integrations/:id", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const { id } = request.params as { id: string };
  const integration = getHttpsIntegration(id);
  if (!integration) return reply.code(404).send({ error: "unknown HTTPS integration" });
  return { integration, runtime: await httpsOverview(), summary: httpsSummary(id) };
});

app.post("/https/ca/prepare", async (request, reply) => {
  if (!authorized(request, reply)) return;

  const runtime = await httpsOverview();
  if (runtime.active) {
    return reply.code(409).send({
      error: "stop the active HTTPS integration before preparing the CA",
    });
  }

  try {
    await ensureHttpsCa();
    return {
      ok: true,
      result: "ready",
      runtime: await httpsOverview(),
    };
  } catch (error) {
    const safe = safeProcessError(error);
    return reply.code(500).send({
      error: safe.stderr || "unable to prepare HTTPS CA",
    });
  }
});

app.get("/https/ca", async (request, reply) => {
  if (!authorized(request, reply)) return;

  try {
    const certificate = fs.readFileSync(httpsPublicCaFile);
    const parsed = new X509Certificate(certificate);
    return {
      filename: "tunnelblock-ca.cer",
      contentType: "application/x-x509-ca-cert",
      base64: certificate.toString("base64"),
      fingerprint256: parsed.fingerprint256,
    };
  } catch {
    return reply.code(404).send({
      error: "HTTPS CA not prepared",
    });
  }
});

app.post("/integrations/:id/actions/:action", async (request, reply) => {
  if (!authorized(request, reply)) return;
  const { id, action } = request.params as { id: string; action: string };
  const integration = getHttpsIntegration(id);
  if (!integration) return reply.code(404).send({ error: "unknown HTTPS integration" });
  if (!validIntegrationAction(integration, action)) return reply.code(400).send({ error: "unsupported HTTPS integration action" });
  if (liveUpdateState().running) return reply.code(409).send({ error: "deployment in progress: HTTPS integration changes are temporarily disabled" });
  const metadata = integration.actions.find(item => item.id === action)!;
  const runtime = await httpsOverview();
  try {
    if (metadata.kind === "summary") return { ok: true, summary: httpsSummary(id) };
    if (metadata.kind === "clear") {
      for (const suffix of ["", ".1"]) fs.rmSync(path.join(repoDir, "data", "https", "observations", `${id}.jsonl${suffix}`), { force: true });
      return { ok: true, summary: httpsSummary(id) };
    }
    if (metadata.kind === "certificate") {
      if (runtime.active) return reply.code(409).send({ error: "stop HTTPS inspection before preparing the CA" });
      await ensureHttpsCa();
      const certificate = fs.readFileSync(httpsPublicCaFile);
      const parsed = new X509Certificate(certificate);
      return { ok: true, certificate: { filename: "tunnelblock-ca.cer", contentType: "application/x-x509-ca-cert",
        base64: certificate.toString("base64"), fingerprint256: parsed.fingerprint256 } };
    }
    if (metadata.kind === "stop") {
      if (runtime.active && runtime.integration !== id) return reply.code(409).send({ error: `another HTTPS integration is active: ${runtime.integration}` });
      await runHttpsScript("scripts/https-runtime.sh", ["stop"]);
      return { ok: true, runtime: await httpsOverview() };
    }
    if (metadata.kind === "start") {
      if (runtime.active && runtime.integration !== id) return reply.code(409).send({ error: `HTTPS integration already active: ${runtime.integration}` });
      if (!fs.existsSync(httpsPublicCaFile)) return reply.code(409).send({ error: "CA not ready: install and trust it before starting inspection" });
      await runHttpsScript("scripts/https-runtime.sh", ["start", id, "observe"]);
      return { ok: true, runtime: await httpsOverview() };
    }
    return reply.code(400).send({ error: "unsupported HTTPS integration action" });
  } catch (error) {
    const safe = safeProcessError(error);
    return reply.code(500).send({ error: safe.stderr || "HTTPS integration action failed" });
  }
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

await app.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 8090),
});

setTimeout(() => void reconcileInterruptedDeployment(), 15_000);
setTimeout(() => void checkForUpdates(), 20_000);
setTimeout(() => void refreshExternalBlocklists(), 60_000);

setInterval(() => void checkForUpdates(), pollIntervalSec * 1000);
setInterval(
  () => void refreshExternalBlocklists(),
  listRefreshIntervalHours * 60 * 60 * 1000,
);
