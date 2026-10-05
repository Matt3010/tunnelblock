import assert from "node:assert/strict";
import test from "node:test";
import { LoginLimiter, credentialsMatch, parseBasicAuth } from "../src/auth.js";

function basic(value: string) {
  return `Basic ${Buffer.from(value).toString("base64")}`;
}

test("parses Basic credentials, keeping colons in the password", () => {
  assert.deepEqual(parseBasicAuth(basic("admin:pa:ss")), { user: "admin", password: "pa:ss" });
  assert.deepEqual(parseBasicAuth(`basic ${Buffer.from("admin:x").toString("base64")}`), { user: "admin", password: "x" });
  assert.equal(parseBasicAuth(undefined), null);
  assert.equal(parseBasicAuth("Bearer abc"), null);
  assert.equal(parseBasicAuth(basic("no-colon")), null);
});

test("credentials must match both user and password exactly", () => {
  const expected = { user: "admin", password: "correct horse battery" };
  assert.equal(credentialsMatch(expected, { user: "admin", password: "correct horse battery" }), true);
  assert.equal(credentialsMatch(expected, { user: "admin", password: "correct horse batter" }), false);
  assert.equal(credentialsMatch(expected, { user: "root", password: "correct horse battery" }), false);
  assert.equal(credentialsMatch(expected, null), false);
});

test("locks a source out after repeated failures until the window passes", () => {
  let now = 0;
  const limiter = new LoginLimiter(3, 15 * 60_000, () => now);

  assert.equal(limiter.blocked("192.168.1.9"), false);
  limiter.fail("192.168.1.9");
  limiter.fail("192.168.1.9");
  assert.equal(limiter.blocked("192.168.1.9"), false);
  limiter.fail("192.168.1.9");
  assert.equal(limiter.blocked("192.168.1.9"), true);
  assert.equal(limiter.blocked("192.168.1.10"), false);

  now += 15 * 60_000;
  assert.equal(limiter.blocked("192.168.1.9"), false);
});

test("a successful login clears earlier failures", () => {
  const limiter = new LoginLimiter(2, 60_000, () => 0);
  limiter.fail("10.66.66.2");
  limiter.succeed("10.66.66.2");
  limiter.fail("10.66.66.2");
  assert.equal(limiter.blocked("10.66.66.2"), false);
});
