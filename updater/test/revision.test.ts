import assert from "node:assert/strict";
import test from "node:test";
import { runtimeNeedsDeployment } from "../src/revision.js";

const oldSha = "715bdd4e58556dff86ca1427a94db063bf45b354";
const newSha = "f5f2ed5754236293f67e03efb33ae8e7ab628732";

test("deploys when checkout is current but the running build is stale", () => {
  assert.equal(runtimeNeedsDeployment(newSha, oldSha), true);
});

test("does not redeploy the revision already running", () => {
  assert.equal(runtimeNeedsDeployment(newSha, newSha), false);
});

test("ignores development build placeholders", () => {
  assert.equal(runtimeNeedsDeployment(newSha, "dev"), false);
  assert.equal(runtimeNeedsDeployment(newSha, "unknown"), false);
});
