import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedUser, isPrivateChat, parseAllowedUserIds } from "../src/access.js";

test("parses allowed Telegram users", () => {
  const allowed = parseAllowedUserIds("123, 456,,");
  assert.equal(allowed.size, 2);
  assert.equal(isAllowedUser(allowed, 123), true);
  assert.equal(isAllowedUser(allowed, 999), false);
});

test("only private chats are accepted", () => {
  assert.equal(isPrivateChat("private"), true);
  assert.equal(isPrivateChat("group"), false);
  assert.equal(isPrivateChat("supergroup"), false);
  assert.equal(isPrivateChat("channel"), false);
});
