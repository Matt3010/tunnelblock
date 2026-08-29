import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlocklistManager, parseBlocklist } from "../src/lists.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

describe("BlocklistManager attribution", () => {
  it("identifies the source list and exact parent rule", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adblock-lists-"));
    tempDirs.push(dir);

    fs.mkdirSync(path.join(dir, "lists"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify([
      {
        id: "abc123def456",
        url: "https://example.com/list.txt",
        enabled: true,
        addedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        domainCount: 1,
        lastError: null,
      },
    ]));
    fs.writeFileSync(path.join(dir, "lists", "abc123def456.txt"), "example.com\n");
    fs.writeFileSync(path.join(dir, "external-block.txt"), "example.com\n");

    const manager = new BlocklistManager(
      dir,
      path.join(dir, "external-block.txt"),
    );

    expect(manager.findMatch("ads.deep.example.com")).toEqual({
      source: expect.objectContaining({
        id: "abc123def456",
        url: "https://example.com/list.txt",
      }),
      matchedRule: "example.com",
    });
  });

  it("ignores disabled lists when attributing a match", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adblock-lists-"));
    tempDirs.push(dir);

    fs.mkdirSync(path.join(dir, "lists"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify([
      {
        id: "abc123def456",
        url: "https://example.com/list.txt",
        enabled: false,
        addedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        domainCount: 1,
        lastError: null,
      },
    ]));
    fs.writeFileSync(path.join(dir, "lists", "abc123def456.txt"), "example.com\n");
    fs.writeFileSync(path.join(dir, "external-block.txt"), "");

    const manager = new BlocklistManager(
      dir,
      path.join(dir, "external-block.txt"),
    );

    expect(manager.findMatch("ads.example.com")).toBeNull();
    expect(manager.activeCount()).toBe(0);
  });
});
