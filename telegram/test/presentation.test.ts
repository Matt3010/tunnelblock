import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticsText,
  domainDetailView,
  escapeHtml,
  fitsTelegramTextLimit,
  formatBytes,
  formatCount,
  formatDuration,
  listDetailView,
  listsView,
  serviceIcon,
  statusText,
  updateStatusText,
} from "../src/presentation.js";

test("escapes Telegram HTML safely", () => {
  assert.equal(escapeHtml('<tag a="1">&'), "&lt;tag a=\"1\"&gt;&amp;");
});

test("formats counts, duration and bytes", () => {
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(formatDuration(7384), "2h 3m");
  assert.equal(formatBytes(1536), "1.5 KiB");
});

test("maps runtime states to clear icons", () => {
  assert.equal(serviceIcon("healthy"), "✅");
  assert.equal(serviceIcon("stopped"), "⚪");
  assert.equal(serviceIcon("unhealthy"), "❌");
  assert.equal(serviceIcon("starting"), "🔄");
});

test("status view is compact and readable", () => {
  const text = statusText({
    ok: true,
    uptimeSec: 7384,
    queries: 12345,
    blocked: 2345,
    blockRate: 19,
    blocklists: 1,
    externalBlockedDomains: 186542,
    blocklistDuplicateEntries: 0,
    blocklistErrors: 0,
  });
  assert.match(text, /TunnelBlock Status/);
  assert.match(text, /12,345/);
  assert.match(text, /2h 3m/);
  assert.ok(fitsTelegramTextLimit(text));
});

test("diagnostics view distinguishes stopped from unhealthy", () => {
  const text = diagnosticsText({
    health: "✅ OK · sqlite",
    ready: "✅ OK · sqlite",
    updaterLine: "✅ success · <code>abc12345</code>",
    serviceLines: [
      "✅ doh-a · healthy",
      "⚪ HTTPS proxy · stopped",
    ],
    runtimeLine: "Updater gen 5 · Bot gen 7",
  });
  assert.match(text, /⚪ HTTPS proxy · stopped/);
  assert.ok(fitsTelegramTextLimit(text));
});

test("domain and blocklist details escape untrusted values", () => {
  const domain = domainDetailView({
    domain: "<evil.example>",
    state: "block",
    decision: "block",
    count: 2,
    matchedRule: "<rule>",
    blocklists: [],
  }, 0);
  assert.match(domain.text, /&lt;evil\.example&gt;/);
  assert.doesNotMatch(domain.text, /<evil\.example>/);

  const list = listDetailView({
    id: "0123456789ab",
    url: "https://example.com/<list>",
    enabled: true,
    cachedDomainCount: 10,
    uniqueDomainCount: 8,
    overlapDomainCount: 2,
    updatedAt: null,
    lastError: null,
  });
  assert.match(list.text, /&lt;list&gt;/);
});

test("list overview stays within Telegram message limit", () => {
  const text = listsView({
    items: [{
      id: "0123456789ab",
      url: "https://example.com/list.txt",
      enabled: true,
      cachedDomainCount: 100,
      domainCount: 100,
      lastError: null,
    }],
    activeCount: 1,
    combinedDomainCount: 100,
    duplicateEntries: 0,
    unhealthyCount: 0,
  }).text;
  assert.ok(fitsTelegramTextLimit(text));
});

test("update output is escaped and bounded", () => {
  const text = updateStatusText({
    running: false,
    lastSuccess: false,
    lastStartedAt: "2026-09-03T10:00:00Z",
    lastFinishedAt: "2026-09-03T10:01:00Z",
    lastOutput: "<script>" + "x".repeat(5000),
  });
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
  assert.ok(fitsTelegramTextLimit(text));
});
