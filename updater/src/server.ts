import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import Fastify from "fastify";
import { runtimeNeedsDeployment } from "./revision.js";

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

type HttpsIntegrationAction = {
  id: string;
  label: string;
  kind: string;
};

type HttpsIntegration = {
  id: string;
  name: string;
  description: string;
  hosts: string[];
  actions: HttpsIntegrationAction[];
};

let launching = false;
let integrationBusy = false;
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

const integrationRegistryPath = path.join(
  repoDir,
  "https",
  "config",
  "integrations.json",
);

function loadHttpsIntegrations(): HttpsIntegration[] {
  const payload = JSON.parse(fs.readFileSync(integrationRegistryPath, "utf8")) as {
    integrations?: unknown;
  };

  if (!Array.isArray(payload.integrations)) {
    throw new Error("invalid HTTPS integration registry");
  }

  const seen = new Set<string>();
  return payload.integrations.map((raw: any) => {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const name = typeof raw?.name === "string" ? raw.name : "";
    const description = typeof raw?.description === "string" ? raw.description : "";
    const hosts = Array.isArray(raw?.hosts)
      ? raw.hosts.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const actions = Array.isArray(raw?.actions)
      ? raw.actions
          .filter((value: unknown): value is Record<string, unknown> =>
            Boolean(value) && typeof value === "object",
          )
          .map((value: any) => ({
            id: typeof value.id === "string" ? value.id : "",
            label: typeof value.label === "string" ? value.label : "",
            kind: typeof value.kind === "string" ? value.kind : "",
          }))
      : [];

    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || seen.has(id)) {
      throw new Error("invalid or duplicate HTTPS integration id");
    }
    if (!name || hosts.length === 0 || actions.length === 0) {
      throw new Error(`invalid HTTPS integration: ${id}`);
    }
    for (const action of actions) {
      if (
        !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(action.id) ||
        !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(action.kind) ||
        !action.label
      ) {
        throw new Error(`invalid HTTPS action for ${id}`);
      }
    }

    seen.add(id);
    return { id, name, description, hosts, actions };
  });
}

function getHttpsIntegration(id: string): HttpsIntegration | null {
  return loadHttpsIntegrations().find(item => item.id === id) ?? null;
}

function httpsObservationPath(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    throw new Error("invalid HTTPS integration id");
  }
  return path.join(repoDir, "data", "https", "observations", `${id}.jsonl`);
}

async function httpsProxyRuntime(): Promise<{
  state: string;
  running: boolean;
  integrationId: string | null;
}> {
  let containerId = "";
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "--profile", "https-lab", "ps", "-q", "--all", "https-proxy"],
      { cwd: repoDir, env: process.env },
    );
    containerId = stdout.trim();
  } catch {
    return { state: "missing", running: false, integrationId: null };
  }

  if (!containerId) {
    return { state: "missing", running: false, integrationId: null };
  }

  let state = "unknown";
  let integrationId: string | null = null;

  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        containerId,
      ],
      { env: process.env },
    );
    state = stdout.trim() || "unknown";
  } catch {}

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", containerId],
      { env: process.env },
    );
    const line = stdout
      .split("\n")
      .find(value => value.startsWith("HTTPS_INTEGRATION="));
    integrationId = line ? line.slice("HTTPS_INTEGRATION=".length) : null;
  } catch {}

  return {
    state,
    running: state === "healthy" || state === "running" || state === "starting",
    integrationId,
  };
}

async function runHttpsLab(action: string, integrationId: string): Promise<string> {
  const hostRepoDir = await resolveHostRepoDir();
  const { stdout, stderr } = await execFileAsync(
    "sh",
    ["scripts/https-lab.sh", action, integrationId],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        HOST_REPO_DIR: hostRepoDir,
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

function summarizeHttpsObservation(integrationId: string) {
  const logPath = httpsObservationPath(integrationId);
  let raw = "";
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return {
      available: false,
      records: 0,
      tlsClientHello: 0,
      tlsEstablishedClient: 0,
      tlsFailedClient: 0,
      httpRequests: 0,
      httpResponses: 0,
      uniqueHosts: 0,
      failureCategories: {},
      likelyCertificatePinning: false,
    };
  }

  let records = 0;
  let tlsClientHello = 0;
  let tlsEstablishedClient = 0;
  let tlsFailedClient = 0;
  let httpRequests = 0;
  let httpResponses = 0;
  const hosts = new Set<string>();
  const failureCategories: Record<string, number> = {};

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      records += 1;
      const event = record.event;
      if (event === "tls_clienthello") tlsClientHello += 1;
      if (event === "tls_established_client") tlsEstablishedClient += 1;
      if (event === "tls_failed_client") {
        tlsFailedClient += 1;
        const category =
          typeof record.error_category === "string"
            ? record.error_category
            : "unknown";
        failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      }
      if (event === "http_request") {
        httpRequests += 1;
        if (typeof record.host === "string") hosts.add(record.host);
      }
      if (event === "http_response") httpResponses += 1;
    } catch {}
  }

  return {
    available: true,
    records,
    tlsClientHello,
    tlsEstablishedClient,
    tlsFailedClient,
    httpRequests,
    httpResponses,
    uniqueHosts: hosts.size,
    failureCategories,
    likelyCertificatePinning:
      tlsClientHello > 0 &&
      tlsFailedClient > 0 &&
      tlsEstablishedClient === 0 &&
      httpRequests === 0,
  };
}

async function publicHttpsCertificate(integrationId: string) {
  await runHttpsLab("ca-prepare", integrationId);
  const pemPath = path.join(
    repoDir,
    "data",
    "https",
    "ca",
    "mitmproxy-ca-cert.pem",
  );
  const pem = fs.readFileSync(pemPath);
  const certificate = new X509Certificate(pem);

  return {
    filename: "adblock-general-purpose-ca.cer",
    contentType: "application/x-x509-ca-cert",
    certificateBase64: certificate.raw.toString("base64"),
    fingerprint256: certificate.fingerprint256,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
  };
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
    "❌ Aggiornamento AdBlock interrotto: il deployment helper non è più in esecuzione.",
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
        ? "🔄 Nuovo push su master rilevato. Aggiornamento AdBlock avviato."
        : "🔄 Aggiornamento AdBlock avviato.",
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
      `❌ Impossibile avviare l'aggiornamento AdBlock: ${message}`,
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

  const [dohA, dohB, telegram, wireguard] = await Promise.all([
    serviceRuntimeState("doh-a"),
    serviceRuntimeState("doh-b"),
    serviceRuntimeState("telegram-bot"),
    serviceRuntimeState("wireguard"),
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

app.get("/integrations", async (request, reply) => {
  if (!authorized(request, reply)) return;

  const runtime = await httpsProxyRuntime();
  return {
    runtime,
    items: loadHttpsIntegrations().map(item => ({
      ...item,
      active: runtime.running && runtime.integrationId === item.id,
    })),
  };
});

app.get("/integrations/:id", async (request, reply) => {
  if (!authorized(request, reply)) return;

  const { id } = request.params as { id: string };
  const integration = getHttpsIntegration(id);
  if (!integration) {
    return reply.code(404).send({ error: "integration not found" });
  }

  const runtime = await httpsProxyRuntime();
  return {
    ...integration,
    active: runtime.running && runtime.integrationId === integration.id,
    runtime,
    summary: summarizeHttpsObservation(integration.id),
  };
});

app.post("/integrations/:id/actions/:action", async (request, reply) => {
  if (!authorized(request, reply)) return;

  const { id, action } = request.params as { id: string; action: string };
  const integration = getHttpsIntegration(id);
  if (!integration) {
    return reply.code(404).send({ error: "integration not found" });
  }

  const registeredAction = integration.actions.find(item => item.id === action);
  if (!registeredAction) {
    return reply.code(404).send({ error: "integration action not found" });
  }

  const updateState = loadUpdateState();
  if (updateState.running || launching) {
    return reply.code(409).send({
      error: "HTTPS integration actions are unavailable during deployment",
    });
  }
  if (integrationBusy) {
    return reply.code(409).send({ error: "another HTTPS integration action is running" });
  }

  integrationBusy = true;
  try {
    if (registeredAction.kind === "certificate") {
      return {
        ok: true,
        integration: integration.id,
        certificate: await publicHttpsCertificate(integration.id),
      };
    }

    if (registeredAction.kind === "start") {
      const runtime = await httpsProxyRuntime();
      if (runtime.running && runtime.integrationId !== integration.id) {
        return reply.code(409).send({
          error: `another integration is active: ${runtime.integrationId ?? "unknown"}`,
        });
      }

      const output = await runHttpsLab("start", integration.id);
      return {
        ok: true,
        integration: integration.id,
        output,
        runtime: await httpsProxyRuntime(),
      };
    }

    if (registeredAction.kind === "stop") {
      const runtime = await httpsProxyRuntime();
      if (runtime.running && runtime.integrationId && runtime.integrationId !== integration.id) {
        return reply.code(409).send({
          error: `another integration is active: ${runtime.integrationId}`,
        });
      }

      const output = await runHttpsLab("stop", integration.id);
      return {
        ok: true,
        integration: integration.id,
        output,
        runtime: await httpsProxyRuntime(),
      };
    }

    if (registeredAction.kind === "summary") {
      return {
        ok: true,
        integration: integration.id,
        summary: summarizeHttpsObservation(integration.id),
      };
    }

    if (registeredAction.kind === "clear") {
      const logPath = httpsObservationPath(integration.id);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "");
      try {
        fs.unlinkSync(logPath + ".1");
      } catch {}
      return {
        ok: true,
        integration: integration.id,
        summary: summarizeHttpsObservation(integration.id),
      };
    }

    return reply.code(400).send({
      error: `unsupported integration action kind: ${registeredAction.kind}`,
    });
  } catch (error) {
    const safe = safeProcessError(error);
    app.log.error(
      { integration: integration.id, action, error: safe },
      "https-integration-action-failed",
    );
    return reply.code(500).send({
      error:
        safe.stderr ||
        (error instanceof Error ? error.message : String(error)),
    });
  } finally {
    integrationBusy = false;
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
