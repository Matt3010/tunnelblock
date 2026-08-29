#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2];
if (!["running", "success", "failed"].includes(mode)) {
  throw new Error("usage: update-state.mjs <running|success|failed>");
}

const stateFile = process.env.UPDATER_STATE_FILE ?? "/updater-data/state.json";
const logFile = process.env.UPDATER_LOG_FILE ?? "/updater-data/deploy.log";
const targetSha = process.env.TARGET_SHA || null;
const startedAtFromEnv = process.env.DEPLOY_STARTED_AT || null;

let previous = {};
try {
  previous = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {}

let output = "";
try {
  output = fs.readFileSync(logFile, "utf8");
} catch {}
if (output.length > 12000) output = output.slice(-12000);

const now = new Date().toISOString();
const state = {
  running: mode === "running",
  lastStartedAt:
    mode === "running"
      ? (startedAtFromEnv ?? now)
      : (previous.lastStartedAt ?? startedAtFromEnv ?? now),
  lastFinishedAt: mode === "running" ? null : now,
  lastSuccess: mode === "running" ? null : mode === "success",
  lastOutput: output,
  lastSeenRemoteSha:
    mode === "success"
      ? targetSha
      : (previous.lastSeenRemoteSha ?? null),
  failedRemoteSha:
    mode === "failed"
      ? targetSha
      : mode === "success"
        ? null
        : (previous.failedRemoteSha ?? null),
};

fs.mkdirSync(path.dirname(stateFile), { recursive: true });
const tmp = stateFile + ".tmp-" + process.pid;
fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
fs.renameSync(tmp, stateFile);
