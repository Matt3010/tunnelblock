import assert from "node:assert/strict";
import test from "node:test";
import { fitsTelegramTextLimit } from "../src/presentation.js";
import {
  hexToIp,
  hostAccess,
  ipToHex,
  lanAccessView,
  lanHostView,
  lanHosts,
  lanSummary,
  parseManualRule,
  toggleHostAll,
  togglePort,
  type LanInventory,
} from "../src/lan.js";

const inventory: LanInventory = {
  scannedAt: "2026-09-29T10:00:00.000Z",
  interface: "eth0",
  target: "192.168.1.5/24",
  hosts: [
    { ip: "192.168.1.20", hostname: "nas.lan", vendor: "Synology", ports: [
      { protocol: "tcp", port: 22, service: "ssh" },
      { protocol: "tcp", port: 5000, service: "upnp" },
    ] },
    { ip: "192.168.1.5", hostname: null, vendor: null, self: true, ports: [{ protocol: "tcp", port: 22, service: "ssh" }] },
  ],
};
const now = Date.parse("2026-09-29T10:12:00.000Z");

test("encodes hosts compactly for callback data", () => {
  assert.equal(ipToHex("192.168.1.20"), "c0a80114");
  assert.equal(hexToIp("c0a80114"), "192.168.1.20");
  assert.equal(hexToIp("zz"), null);
});

test("toggles ports and whole-device access", () => {
  let rules = togglePort([], "192.168.1.20", "tcp", 22);
  assert.deepEqual(rules, ["192.168.1.20/tcp/22"]);
  rules = toggleHostAll(rules, "192.168.1.20");
  assert.deepEqual(rules, ["192.168.1.20/any"]);
  rules = togglePort(rules, "192.168.1.20", "tcp", 5000);
  assert.deepEqual(rules, ["192.168.1.20/tcp/5000"]);
  rules = togglePort(rules, "192.168.1.20", "tcp", 5000);
  assert.deepEqual(rules, []);
});

test("parses manual rules and rejects public addresses", () => {
  assert.equal(parseManualRule("192.168.1.50"), "192.168.1.50/any");
  assert.equal(parseManualRule("192.168.1.50:8123"), "192.168.1.50/tcp/8123");
  assert.equal(parseManualRule("192.168.1.50 8123"), "192.168.1.50/tcp/8123");
  assert.equal(parseManualRule("192.168.1.50 udp 1900"), "192.168.1.50/udp/1900");
  assert.equal(parseManualRule("192.168.1.50 tcp:443"), "192.168.1.50/tcp/443");
  assert.equal(parseManualRule("8.8.8.8"), null);
  assert.equal(parseManualRule("192.168.1.50:70000"), null);
  assert.equal(parseManualRule("nas.lan"), null);
});

test("merges rule-only hosts with discovered devices", () => {
  const hosts = lanHosts({ mode: "custom", rules: ["192.168.1.99/udp/1900", "192.168.1.20/tcp/8080"] }, inventory);
  assert.deepEqual(hosts.map(host => [host.ip, host.discovered]), [
    ["192.168.1.5", true],
    ["192.168.1.20", true],
    ["192.168.1.99", false],
  ]);
  assert.deepEqual(hosts[1].ports.map(port => port.port), [22, 5000, 8080]);
});

test("summarizes access modes", () => {
  assert.equal(lanSummary(undefined), "🔓 Full LAN");
  assert.equal(lanSummary({ mode: "custom", rules: [] }), "🌐 Internet only");
  assert.equal(lanSummary({ mode: "custom", rules: ["192.168.1.20/tcp/22", "192.168.1.20/tcp/5000"] }), "🎯 1 device · 2 rules");
  assert.equal(hostAccess({ mode: "full", rules: [] }, "192.168.1.20").all, true);
});

test("LAN views stay within Telegram limits", () => {
  const acl = { mode: "custom" as const, rules: ["192.168.1.20/tcp/22"] };
  const name = "a".repeat(32);
  const home = lanAccessView(name, acl, inventory, { running: false, error: null }, 0, now);
  assert.match(home.text, /12m ago/);
  assert.match(home.text, /1 device · 1 rule/);
  const host = lanHostView(name, acl, inventory, "192.168.1.20");
  assert.match(host.text, /Synology/);

  for (const view of [home, host]) {
    assert.ok(fitsTelegramTextLimit(view.text));
    for (const button of view.reply_markup.inline_keyboard.flat()) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
    }
  }
  assert.ok(host.reply_markup.inline_keyboard.flat().some(button => button.text.startsWith("✅ 22/tcp SSH")));
});

test("LAN views escape discovered names", () => {
  const hostile: LanInventory = { ...inventory, hosts: [{ ip: "192.168.1.7", hostname: "<b>x</b>", vendor: null, ports: [] }] };
  const view = lanHostView("phone", { mode: "custom", rules: [] }, hostile, "192.168.1.7");
  assert.doesNotMatch(view.text, /<b>x<\/b>/);
});
