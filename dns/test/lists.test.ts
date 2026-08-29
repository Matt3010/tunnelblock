import { describe, expect, it } from "vitest";
import { parseBlocklist } from "../src/lists.js";

describe("parseBlocklist", () => {
  it("parses plain domains, hosts files and Adblock rules", () => {
    const result = parseBlocklist([
      "# comment",
      "! another comment",
      "ads.example.com",
      "0.0.0.0 tracker.example.net",
      "127.0.0.1 metrics.example.org",
      "||sponsor.example.io^",
      "||video-ads.example.dev^$third-party",
      "@@||allowed.example.com^",
      "/regex-is-ignored/",
    ].join("\n"));

    expect(result).toEqual([
      "ads.example.com",
      "metrics.example.org",
      "sponsor.example.io",
      "tracker.example.net",
      "video-ads.example.dev",
    ]);
  });

  it("deduplicates domains", () => {
    expect(parseBlocklist("ads.example.com\n0.0.0.0 ads.example.com\n")).toEqual([
      "ads.example.com",
    ]);
  });
});
