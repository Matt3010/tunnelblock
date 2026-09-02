import assert from "node:assert/strict";
import test from "node:test";
import { parseHttpsRegistry, summarizeHttpsObservation, validIntegrationAction } from "../src/https-integrations.js";

const registry = JSON.stringify({ version: 1, integrations: [{ id: "instagram", name: "Instagram",
  strategy: "app.strategies.instagram:InstagramStrategy", hostSuffixes: ["instagram.com"],
  actions: [{ id: "start", label: "Start", kind: "start", visibleWhen: "inactive" }] }] });

test("parses and validates integration/action ids", () => {
  const [integration] = parseHttpsRegistry(registry);
  assert.equal(integration.id, "instagram");
  assert.equal(validIntegrationAction(integration, "start"), true);
  assert.equal(validIntegrationAction(integration, "../start"), false);
});

test("rejects duplicate integrations and invalid actions", () => {
  const entry = JSON.parse(registry).integrations[0];
  assert.throws(() => parseHttpsRegistry(JSON.stringify({ version: 1, integrations: [entry, entry] })));
  entry.actions[0].kind = "shell";
  assert.throws(() => parseHttpsRegistry(JSON.stringify({ version: 1, integrations: [entry] })));
});

test("summarizes TLS and detects only a compatible pinning pattern", () => {
  const raw = ['{"event":"tls_clienthello","sni":"i.instagram.com"}',
    '{"event":"tls_failed_client","sni":"i.instagram.com"}'].join("\n");
  assert.equal(summarizeHttpsObservation(raw).likelyCertificatePinning, true);
  assert.equal(summarizeHttpsObservation(raw + '\n{"event":"http_request","host":"i.instagram.com"}').likelyCertificatePinning, false);
});
