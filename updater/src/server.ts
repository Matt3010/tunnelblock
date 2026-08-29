import { spawn } from "node:child_process";
import Fastify from "fastify";

const app = Fastify({ logger: true });
const token = process.env.ADMIN_API_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const repoDir = process.env.REPO_DIR ?? "/workspace";
const branch = process.env.GIT_BRANCH ?? "master";

let running = false;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastSuccess: boolean | null = null;
let lastOutput = "No update has run yet.";

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

function runUpdate() {
  running = true;
  lastStartedAt = new Date().toISOString();
  lastFinishedAt = null;
  lastSuccess = null;
  lastOutput = "";

  const script = `
set -eu
cd "${repoDir}"

git config --global --add safe.directory "${repoDir}"

if [ -n "${GITHUB_TOKEN:-}" ]; then
  git -c http.extraHeader="Authorization: Bearer ${GITHUB_TOKEN}" fetch origin "${branch}"
else
  git fetch origin "${branch}"
fi

git reset --hard "origin/${branch}"

docker compose build doh-a doh-b telegram-bot debug-collector

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

docker compose up -d --no-deps doh-proxy
docker compose up -d --no-deps telegram-bot debug-collector
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
  });
}

app.get("/health", async () => ({ ok: true }));

app.get("/status", async (request, reply) => {
  if (!authorized(request, reply)) return;
  return {
    running,
    lastStartedAt,
    lastFinishedAt,
    lastSuccess,
    lastOutput,
  };
});

app.post("/update", async (request, reply) => {
  if (!authorized(request, reply)) return;
  if (running) return reply.code(409).send({ error: "update already running" });

  runUpdate();
  return reply.code(202).send({ ok: true, started: true });
});

await app.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 8090),
});
