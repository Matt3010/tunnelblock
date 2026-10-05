import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLanChange,
  hostAccess,
  lanDevices,
  lanSummary,
  parseManualRule,
  portLabel,
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
  assert.equal(parseManualRule("192.168.1.50 udp 1900"), "192.168.1.50/udp/1900");
  assert.equal(parseManualRule("8.8.8.8"), null);
  assert.equal(parseManualRule("192.168.1.50:70000"), null);
  assert.equal(parseManualRule("nas"), null);
});

test("lists discovered and rule-only devices with their access, sorted by address", () => {
  const devices = lanDevices({ mode: "custom", rules: ["192.168.1.20/tcp/22", "192.168.1.99/udp/1900"] }, inventory);

  assert.deepEqual(devices.map(device => device.ip), ["192.168.1.5", "192.168.1.20", "192.168.1.99"]);
  assert.equal(devices[0].label, "device (server)");
  assert.deepEqual(devices[1].ports.map(port => [port.label, port.allowed]), [["22/tcp SSH", true], ["5000/tcp upnp", false]]);
  assert.equal(devices[1].all, false);
  assert.equal(devices[2].discovered, false);
  assert.deepEqual(devices[2].ports.map(port => [port.label, port.allowed]), [["1900/udp", true]]);
});

test("full mode grants every device", () => {
  const devices = lanDevices({ mode: "full", rules: [] }, inventory);
  assert.ok(devices.every(device => device.all));
  assert.equal(hostAccess({ mode: "full", rules: [] }, "192.168.1.20").all, true);
});

test("applies LAN changes requested by the web UI", () => {
  const custom = { mode: "custom" as const, rules: ["192.168.1.20/tcp/22"] };

  assert.deepEqual(applyLanChange(custom, { kind: "mode", mode: "full" }), { mode: "full", rules: [] });
  assert.deepEqual(applyLanChange(custom, { kind: "mode", mode: "none" }), { mode: "custom", rules: [] });
  assert.deepEqual(applyLanChange(custom, { kind: "all", ip: "192.168.1.20" }), { mode: "custom", rules: ["192.168.1.20/any"] });
  assert.deepEqual(
    applyLanChange(custom, { kind: "port", ip: "192.168.1.20", protocol: "tcp", port: 5000 }),
    { mode: "custom", rules: ["192.168.1.20/tcp/22", "192.168.1.20/tcp/5000"] },
  );
  assert.deepEqual(
    applyLanChange(custom, { kind: "manual", text: "192.168.1.20" }),
    { mode: "custom", rules: ["192.168.1.20/any"] },
  );
  assert.deepEqual(
    applyLanChange({ mode: "full", rules: [] }, { kind: "port", ip: "192.168.1.20", protocol: "tcp", port: 22 }),
    { mode: "custom", rules: ["192.168.1.20/tcp/22"] },
  );
  assert.equal(applyLanChange(custom, { kind: "manual", text: "8.8.8.8" }), null);
  assert.equal(applyLanChange(custom, { kind: "all", ip: "8.8.8.8" }), null);
});

test("summarises access and labels ports", () => {
  assert.equal(lanSummary(undefined), "Full LAN");
  assert.equal(lanSummary({ mode: "custom", rules: [] }), "Internet only");
  assert.equal(lanSummary({ mode: "custom", rules: ["192.168.1.20/tcp/22", "192.168.1.20/tcp/80"] }), "1 device · 2 rules");
  assert.equal(portLabel({ protocol: "tcp", port: 8123, service: null }), "8123/tcp Home Assistant");
});
