import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateAddress } from "../src/net.js";

test("accepts LAN, VPN, Docker and loopback sources", () => {
  for (const ip of [
    "192.168.1.20",
    "10.66.66.2",
    "172.18.0.5",
    "127.0.0.1",
    "169.254.10.1",
    "::1",
    "::ffff:192.168.1.20",
    "fd42:66:66::2",
    "fe80::1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("rejects Internet sources and garbage", () => {
  for (const ip of [
    "8.8.8.8",
    "172.32.0.1",
    "192.169.0.1",
    "::ffff:8.8.8.8",
    "2a00:1450::1",
    "",
    "not-an-ip",
    "999.1.1.1",
  ]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});
