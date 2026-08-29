import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let stats: typeof import("../src/stats.js");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-capture-"));
  process.env.STATS_DB_PATH = path.join(dir, "stats.sqlite");
  stats = await import("../src/stats.js");
});

describe("YouTube DNS capture", () => {
  it("persists labeled sessions and separates ad-only, video-only and shared domains", async () => {
    const ad = await stats.startYouTubeCapture("ad");
    expect(ad.label).toBe("ad");
    expect(await stats.getYouTubeCaptureStatus()).toEqual(
      expect.objectContaining({
        active: true,
        label: "ad",
      }),
    );

    await stats.recordQuery("ad-only.example", "allow");
    await stats.recordQuery("shared.example", "allow");
    await stats.recordQuery("shared.example", "allow");

    const stoppedAd = await stats.stopYouTubeCapture();
    expect(stoppedAd).toEqual(
      expect.objectContaining({
        label: "ad",
        domains: 2,
        queries: 3,
      }),
    );

    const video = await stats.startYouTubeCapture("video");
    expect(video.label).toBe("video");

    await stats.recordQuery("video-only.example", "allow");
    await stats.recordQuery("shared.example", "allow");

    const stoppedVideo = await stats.stopYouTubeCapture();
    expect(stoppedVideo).toEqual(
      expect.objectContaining({
        label: "video",
        domains: 2,
        queries: 2,
      }),
    );

    expect(await stats.getYouTubeCaptureStatus()).toEqual({ active: false });

    const report = await stats.getYouTubeReport(20);

    expect(report.ad.sessions).toBe(1);
    expect(report.video.sessions).toBe(1);
    expect(report.adOnly).toContainEqual(
      expect.objectContaining({
        domain: "ad-only.example",
        adCount: 1,
        videoCount: 0,
        adSessions: 1,
      }),
    );
    expect(report.videoOnly).toContainEqual(
      expect.objectContaining({
        domain: "video-only.example",
        adCount: 0,
        videoCount: 1,
        videoSessions: 1,
      }),
    );
    expect(report.shared).toContainEqual(
      expect.objectContaining({
        domain: "shared.example",
        adCount: 2,
        videoCount: 1,
      }),
    );
  });

  it("rejects overlapping captures and stopping without an active capture", async () => {
    await stats.startYouTubeCapture("ad");
    await expect(stats.startYouTubeCapture("video")).rejects.toThrow(
      "youtube capture already active",
    );
    await stats.stopYouTubeCapture();
    await expect(stats.stopYouTubeCapture()).rejects.toThrow(
      "no youtube capture is active",
    );
  });
});
