/// <reference types="vite/client" />

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";

import {
  downloadRange,
  extractFilmstrip,
  extractPreviewFrame,
  getYouTubeMetadata,
  probeSource,
} from "./backend";
import type { DownloadRangeRequest } from "./types";

afterEach(() => clearMocks());

describe("typed backend IPC", () => {
  it("calls only the expected source commands with structured payloads", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      return null;
    });

    const download: DownloadRangeRequest = {
      url: "https://youtu.be/abc123",
      selection: { start: 10_000_000, end: 20_000_000 },
      sourceDuration: 30_000_000,
      quality: "p720",
      outputDir: "C:\\media output",
    };

    await probeSource("C:\\فيديوهات\\My Clip 01.mp4");
    await getYouTubeMetadata("https://youtu.be/abc123");
    await downloadRange(download);
    await extractPreviewFrame({
      source: "C:\\media\\source.mp4",
      timestamp: 5_000_000,
      destination: "C:\\cache\\preview.jpg",
    });
    await extractFilmstrip({
      source: "C:\\media\\source.mp4",
      range: { start: 0, end: 10_000_000 },
      count: 5,
      destinationDir: "C:\\cache\\filmstrip",
    });

    expect(calls).toEqual([
      {
        command: "probe_source",
        payload: { path: "C:\\فيديوهات\\My Clip 01.mp4" },
      },
      {
        command: "youtube_metadata",
        payload: { url: "https://youtu.be/abc123" },
      },
      { command: "download_range", payload: { request: download } },
      {
        command: "extract_preview_frame",
        payload: {
          request: {
            source: "C:\\media\\source.mp4",
            timestamp: 5_000_000,
            destination: "C:\\cache\\preview.jpg",
          },
        },
      },
      {
        command: "extract_filmstrip",
        payload: {
          request: {
            source: "C:\\media\\source.mp4",
            range: { start: 0, end: 10_000_000 },
            count: 5,
            destinationDir: "C:\\cache\\filmstrip",
          },
        },
      },
    ]);
  });

  it("keeps shell access out of production frontend modules", () => {
    const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx"], {
      eager: true,
      import: "default",
      query: "?raw",
    }) as Record<string, string>;

    for (const [path, source] of Object.entries(sources)) {
      if (!path.includes(".test.")) {
        expect(source, path).not.toContain("@tauri-apps/plugin-shell");
      }
    }
  });
});
