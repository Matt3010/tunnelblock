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
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

let running = false;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastSuccess: boolean | null = null;
let lastOutput = "No update has run yet.";
let lastSeenRemoteSha: string | null = null;
let failedRemoteSha: string | null = null;

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

function runUpdate(trigger: "manual" | "automatic" = "manual") {
  running = true;
  lastStartedAt = new Date().toISOString();
  lastFinishedAt = null;
  lastSuccess = null;
  lastOutput = "";

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

echo "== Pre-flight: build and validate proxy image =="
if ! docker compose build doh-proxy; then
  echo "Proxy build/validation failed; restoring previous checkout."
  git reset --hard "$PREVIOUS_SHA"
  exit 11
fi

echo "== Pre-flight passed =="

docker compose build updater doh-a doh-b telegram-bot debug-collector

docker compose up -d --no-deps doh-a
for i in $(seq 1 30); do
  docker compose exec -T doh-a node -e "fetch('http://127.0.0.1:8053/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  [ "$i" -eq 30 ] && exit 1
  sleep 1
done

docker compose up -d --no-deps doh-b
for i in $(seq 1 30); do
  docker compose exec -T doh-b node -e "fetch('http://127.0.0.1:8053/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  [ "$i" -eq 30 ] && exit 1
  sleep 1
done

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
  });

  child.stderr.on("data", chunk => {
    lastOutput = tail(lastOutput + chunk.toString());
  });

  child.on("close", code => {
    running = false;
    lastFinishedAt = new Date().toISOString();
    lastSuccess = code === 0;
    lastOutput = tail(lastOutput + `\nExit code: ${code}\n`);

    void (async () => {
      if (code === 0) {
        failedRemoteSha = null;
        try {
          lastSeenRemoteSha = await localSha();
        } catch {}
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

    if (!lastSeenRemoteSha) lastSeenRemoteSha = local;

    if (remote === failedRemoteSha) {
      app.log.warn({ remote }, "skipping-previously-failed-revision");
      return;
    }

    if (remote !== local) {
      app.log.info({ local, remote }, "new-master-revision-detected");
      runUpdate("automatic");
    } else {
      lastSeenRemoteSha = remote;
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
setInterval(() => void checkForUpdates(), pollIntervalSec * 1000);
