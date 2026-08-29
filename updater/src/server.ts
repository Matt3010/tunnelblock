import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";

const execFileAsync = promisify(execFile);
const app = Fastify({ logger: true });

const token = process.env.ADMIN_API_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const repoDir = process.env.REPO_DIR ?? "/workspace";
const branch = process.env.GIT_BRANCH ?? "master";
const pollIntervalSec = Number(process.env.AUTO_UPDATE_INTERVAL_SEC ?? 300);
const listRefreshIntervalHours = Number(process.env.LIST_REFRESH_INTERVAL_HOURS ?? 24);
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

type UpdateState = {
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccess: boolean | null;
  lastOutput: string;
  lastSeenRemoteSha: string | null;
  failedRemoteSha: string | null;
};

const updaterStateFile = process.env.UPDATER_STATE_FILE ?? "/updater-data/state.json";
const legacyRedisVolume =
  process.env.LEGACY_REDIS_VOLUME ?? "adblock-general-purpose-redis-data";

function loadUpdateState(): UpdateState {
  try {
    const parsed = JSON.parse(fs.readFileSync(updaterStateFile, "utf8")) as Partial<UpdateState>;
    return {
      running: Boolean(parsed.running),
      lastStartedAt: typeof parsed.lastStartedAt === "string" ? parsed.lastStartedAt : null,
      lastFinishedAt: typeof parsed.lastFinishedAt === "string" ? parsed.lastFinishedAt : null,
      lastSuccess: typeof parsed.lastSuccess === "boolean" ? parsed.lastSuccess : null,
      lastOutput: typeof parsed.lastOutput === "string" ? parsed.lastOutput : "No update has run yet.",
      lastSeenRemoteSha: typeof parsed.lastSeenRemoteSha === "string" ? parsed.lastSeenRemoteSha : null,
      failedRemoteSha: typeof parsed.failedRemoteSha === "string" ? parsed.failedRemoteSha : null,
    };
  } catch {
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
}

const loadedState = loadUpdateState();
let running = false;
let lastStartedAt = loadedState.lastStartedAt;
let lastFinishedAt = loadedState.lastFinishedAt;
let lastSuccess = loadedState.lastSuccess;
let lastOutput = loadedState.lastOutput;
let lastSeenRemoteSha = loadedState.lastSeenRemoteSha;
let failedRemoteSha = loadedState.failedRemoteSha;
let persistTimer: NodeJS.Timeout | undefined;

function persistUpdateState(): void {
  fs.mkdirSync(path.dirname(updaterStateFile), { recursive: true });
  const tmp = `${updaterStateFile}.tmp-${process.pid}`;
  const state: UpdateState = {
    running,
    lastStartedAt,
    lastFinishedAt,
    lastSuccess,
    lastOutput,
    lastSeenRemoteSha,
    failedRemoteSha,
  };
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, updaterStateFile);
}

function schedulePersistUpdateState(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    persistUpdateState();
  }, 250);
}

if (loadedState.running) {
  lastFinishedAt = new Date().toISOString();
  lastSuccess = false;
  lastOutput = tail(
    loadedState.lastOutput +
      "\nUpdater restarted while a deployment was running; previous deployment marked interrupted.\n",
  );
  persistUpdateState();
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

function tail(value: string, max = 12000): string {
  return value.length <= max ? value : value.slice(-max);
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

async function fetchRemoteSha(): Promise<string> {
  await execFileAsync(
    "git",
    ["config", "--global", "--add", "safe.directory", repoDir],
    { cwd: repoDir },
  ).catch(() => {});

  const env = { ...process.env };

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is not configured");
  }

  const auth = Buffer.from(`x-access-token:${githubToken}`).toString("base64");

  await execFileAsync(
    "git",
    [
      "-c",
      `http.extraHeader=Authorization: Basic ${auth}`,
      "-c",
      "credential.helper=",
      "fetch",
      "origin",
      branch,
    ],
    { cwd: repoDir, env },
  );

  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", `origin/${branch}`],
    { cwd: repoDir, env },
  );

  return stdout.trim();
}

async function localSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
  });
  return stdout.trim();
}

async function cleanupLegacyRedis(): Promise<void> {
  if (running) return;

  try {
    await execFileAsync("docker", ["compose", "--profile", "legacy-bootstrap", "rm", "-sf", "redis"], {
      cwd: repoDir,
      env: process.env,
    });
  } catch (error) {
    app.log.warn({ error }, "legacy-redis-container-cleanup-skipped");
  }

  try {
    await execFileAsync("docker", ["volume", "rm", legacyRedisVolume], {
      cwd: repoDir,
      env: process.env,
    });
    app.log.info({ volume: legacyRedisVolume }, "legacy-redis-removed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such volume/i.test(message)) {
      app.log.warn({ error }, "legacy-redis-volume-cleanup-skipped");
    }
  }
}

async function refreshExternalBlocklists(): Promise<void> {
  if (!token) return;

  try {
    const response = await fetch("http://doh-proxy:8053/admin/lists/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "{}",
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Blocklist refresh failed: HTTP ${response.status} ${text}`);
    }

    app.log.info({ result: text }, "external-blocklists-refreshed");
  } catch (error) {
    app.log.error({ error }, "external-blocklist-refresh-failed");
  }
}

function runUpdate(trigger: "manual" | "automatic" = "manual") {
  running = true;
  lastStartedAt = new Date().toISOString();
  lastFinishedAt = null;
  lastSuccess = null;
  lastOutput = "";
  persistUpdateState();

  void notifyTelegram(
    trigger === "automatic"
      ? "🔄 Nuovo push su master rilevato. Aggiornamento AdBlock avviato."
      : "🔄 Aggiornamento AdBlock avviato.",
  );

  const script = `
set -eu
cd "${repoDir}"

git config --global --add safe.directory "${repoDir}"

if [ -z "\${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN is not configured"
  exit 2
fi

AUTH="$(printf 'x-access-token:%s' "\${GITHUB_TOKEN}" | base64 | tr -d '\n')"
git -c http.extraHeader="Authorization: Basic $AUTH" -c credential.helper= fetch origin "${branch}"

PREVIOUS_SHA="$(git rev-parse HEAD)"
git reset --hard "origin/${branch}"

HOST_REPO_DIR="$(docker inspect "$(hostname)" --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}')"
if [ -z "$HOST_REPO_DIR" ] || [ ! -d "$HOST_REPO_DIR" ]; then
  echo "Unable to resolve host repository path for /workspace"
  exit 3
fi
export HOST_REPO_DIR
echo "Using host repository path: $HOST_REPO_DIR"

echo "== Pre-flight: repository files =="
test -f "${repoDir}/docker-compose.yml"
test -f "${repoDir}/proxy/Caddyfile"
mkdir -p "${repoDir}/data/rules"

echo "== Pre-flight: docker compose config =="
if ! docker compose config --quiet; then
  echo "Compose validation failed; restoring previous checkout."
  git reset --hard "$PREVIOUS_SHA"
  exit 10
fi

echo "== Pre-flight: build all deployment images =="
if ! docker compose build doh-proxy updater doh-a doh-b telegram-bot debug-collector; then
  echo "Image build failed; restoring previous checkout."
  git reset --hard "$PREVIOUS_SHA"
  exit 11
fi

echo "== Pre-flight: DNS unit tests =="
if ! docker compose run --rm --no-deps --entrypoint npm doh-a test; then
  echo "DNS tests failed; no runtime containers were changed."
  git reset --hard "$PREVIOUS_SHA"
  exit 12
fi

echo "== Pre-flight: TypeScript checks =="
if ! docker compose run --rm --no-deps --entrypoint npm doh-a run typecheck; then
  echo "DNS typecheck failed; no runtime containers were changed."
  git reset --hard "$PREVIOUS_SHA"
  exit 13
fi
if ! docker compose run --rm --no-deps --entrypoint npm telegram-bot run typecheck; then
  echo "Telegram typecheck failed; no runtime containers were changed."
  git reset --hard "$PREVIOUS_SHA"
  exit 14
fi
if ! docker compose run --rm --no-deps --entrypoint npm updater run typecheck; then
  echo "Updater typecheck failed; no runtime containers were changed."
  git reset --hard "$PREVIOUS_SHA"
  exit 15
fi

echo "== Pre-flight passed =="

service_ready() {
  SERVICE="$1"
  CID="$(docker compose ps -q --all "$SERVICE" 2>/dev/null || true)"
  [ -n "$CID" ] || return 1

  STATUS="$(docker inspect "$CID" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  [ "$STATUS" = "healthy" ]
}

wait_ready() {
  SERVICE="$1"
  for i in $(seq 1 45); do
    if service_ready "$SERVICE"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

dump_service() {
  SERVICE="$1"
  echo "== $SERVICE container status =="
  docker compose ps --all "$SERVICE" || true
  echo "== $SERVICE recent logs =="
  docker compose logs --no-color --tail=120 "$SERVICE" || true
}

rollback_resolvers() {
  FAILED_SERVICE="$1"
  EXIT_CODE="$2"

  echo "ERROR: $FAILED_SERVICE failed to become ready."
  dump_service "$FAILED_SERVICE"

  echo "== Rolling BOTH resolvers back to $PREVIOUS_SHA =="
  git reset --hard "$PREVIOUS_SHA"

  ROLLBACK_OK=1
  if ! docker compose build doh-a doh-b; then
    echo "WARNING: rollback image build failed."
    ROLLBACK_OK=0
  elif ! docker compose up -d --no-deps doh-a doh-b; then
    echo "WARNING: rollback container recreation failed."
    ROLLBACK_OK=0
  else
    wait_ready doh-a || ROLLBACK_OK=0
    wait_ready doh-b || ROLLBACK_OK=0
  fi

  if [ "$ROLLBACK_OK" -eq 1 ]; then
    echo "Rollback recovered both resolvers."
  else
    echo "WARNING: rollback did not fully recover both resolvers."
    dump_service doh-a
    dump_service doh-b
  fi

  echo "Deployment remains FAILED regardless of rollback outcome."
  exit "$EXIT_CODE"
}

docker compose up -d --no-deps doh-a
wait_ready doh-a || rollback_resolvers doh-a 21

docker compose up -d --no-deps doh-b
wait_ready doh-b || rollback_resolvers doh-b 22

docker compose up -d --no-deps --force-recreate doh-proxy
docker compose up -d --no-deps telegram-bot debug-collector

echo "== Scheduling updater self-replacement =="
docker run --rm -d   -e HOST_REPO_DIR="$HOST_REPO_DIR"   -v /var/run/docker.sock:/var/run/docker.sock   -v "$HOST_REPO_DIR:/workspace"   -w /workspace   adblock-general-purpose-updater:latest   sh -lc 'sleep 5; docker compose up -d --no-deps updater' >/dev/null
`;

  const child = spawn("/bin/sh", ["-c", script], {
    env: {
      ...process.env,
      GITHUB_TOKEN: githubToken ?? "",
    },
  });

  child.stdout.on("data", chunk => {
    lastOutput = tail(lastOutput + chunk.toString());
    schedulePersistUpdateState();
  });

  child.stderr.on("data", chunk => {
    lastOutput = tail(lastOutput + chunk.toString());
    schedulePersistUpdateState();
  });

  child.on("close", code => {
    running = false;
    lastFinishedAt = new Date().toISOString();
    lastSuccess = code === 0;
    lastOutput = tail(lastOutput + `\nExit code: ${code}\n`);
    persistUpdateState();

    void (async () => {
      if (code === 0) {
        failedRemoteSha = null;
        try {
          lastSeenRemoteSha = await localSha();
        } catch {}
        persistUpdateState();
        await notifyTelegram("✅ AdBlock aggiornato correttamente.");
      } else {
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["rev-parse", `origin/${branch}`],
            { cwd: repoDir },
          );
          failedRemoteSha = stdout.trim();
        } catch {}
        persistUpdateState();
        await notifyTelegram(
          `❌ Aggiornamento AdBlock fallito. Il deploy è stato fermato. Usa /update_status per i dettagli. Exit code: ${code}`,
        );
      }
    })();
  });
}

async function checkForUpdates(): Promise<void> {
  if (running) return;

  try {
    const remote = await fetchRemoteSha();
    const local = await localSha();

    if (!lastSeenRemoteSha) {
      lastSeenRemoteSha = local;
      persistUpdateState();
    }

    if (remote === failedRemoteSha) {
      app.log.warn({ remote }, "skipping-previously-failed-revision");
      return;
    }

    if (remote !== local) {
      app.log.info({ local, remote }, "new-master-revision-detected");
      runUpdate("automatic");
    } else {
      lastSeenRemoteSha = remote;
      schedulePersistUpdateState();
    }
  } catch (error) {
    app.log.error({ error }, "automatic-update-check-failed");
  }
}

app.get("/health", async () => ({ ok: true }));

app.get("/status", async (request, reply) => {
  if (!authorized(request, reply)) return;

  let currentSha: string | null = null;
  try { currentSha = await localSha(); } catch {}

  return {
    running,
    autoUpdate: true,
    githubAuthConfigured: Boolean(githubToken),
    pollIntervalSec,
    statePersistent: true,
    currentSha,
    lastSeenRemoteSha,
    failedRemoteSha,
    lastStartedAt,
    lastFinishedAt,
    lastSuccess,
    lastOutput,
  };
});

app.post("/update", async (request, reply) => {
  if (!authorized(request, reply)) return;
  if (running) return reply.code(409).send({ error: "update already running" });

  runUpdate("manual");
  return reply.code(202).send({ ok: true, started: true });
});

await app.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 8090),
});

setTimeout(() => void checkForUpdates(), 10_000);
setTimeout(() => void cleanupLegacyRedis(), 30_000);
setTimeout(() => void refreshExternalBlocklists(), 60_000);
setInterval(() => void checkForUpdates(), pollIntervalSec * 1000);
setInterval(
  () => void refreshExternalBlocklists(),
  listRefreshIntervalHours * 60 * 60 * 1000,
);
