import { describe, expect, it } from "vitest";
import { makeDebugPayload } from "../src/debug-client.js";

describe("makeDebugPayload", () => {
  it("keeps full utf8 payload", () => {
    const input = "Authorization: Bearer secret\nCookie: sid=abc\nhello";
    const payload = makeDebugPayload(input);

    expect(payload.encoding).toBe("utf8");
    expect(payload.data).toBe(input);
  });

  it("base64 encodes binary payload", () => {
    const payload = makeDebugPayload(new Uint8Array([0, 1, 2, 255]));
    expect(payload.encoding).toBe("base64");
    expect(payload.data).toBe("AAEC/w==");
  });
});
