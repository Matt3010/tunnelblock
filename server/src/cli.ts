import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleEngine } from "./rules.js";
import { DebugClient, makeDebugPayload } from "./debug-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const hostname = process.argv[2];
if (!hostname) {
  console.error("Usage: npm run dev -- <hostname>");
  process.exit(1);
}

const engine = RuleEngine.fromFiles(
  path.join(root, "rules/block.txt"),
  path.join(root, "rules/allow.txt"),
);

const started = performance.now();
const decision = engine.decide(hostname);
const latencyMs = performance.now() - started;

console.log(JSON.stringify({ hostname, decision, latencyMs }, null, 2));

const debug = new DebugClient(
  process.env.DEBUG_ENDPOINT,
  process.env.DEBUG_TOKEN,
);

await debug.emit({
  ts: new Date().toISOString(),
  hostname,
  decision,
  latencyMs,
  source: "cli",
  protocol: "debug",
  payload: makeDebugPayload(`hostname=${hostname}&decision=${decision}`),
});
