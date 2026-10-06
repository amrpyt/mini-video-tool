import { describe, expect, it } from "vitest";

import type { SourceMetadata, YouTubeMetadata } from "../lib/types";
import {
  createInitialEditorState,
  editorReducer,
  requiresNarrowerYouTubeRange,
} from "./editorReducer";

const metadata: SourceMetadata = {
  duration: 120_000_000,
  width: 1920,
  height: 1080,
  frameRate: { numerator: 30_000, denominator: 1_001 },
  hasAudio: true,
};

const youtubeMetadata: YouTubeMetadata = {
  videoId: "abc123",
  title: "Example",
  duration: 120_000_000,
  thumbnailUrl: "https://example.test/thumb.jpg",
  qualities: ["best", "p1080", "p720"],
};

describe("editorReducer", () => {
  it("defaults a local source to the full source range", () => {
    const state = editorReducer(createInitialEditorState(), {
      type: "source/localLoaded",
      path: "C:\\media\\clip.mp4",
      metadata,
    });

    expect(state.project.source.kind).toBe("local");
    expect(state.project.selection).toEqual({ start: 0, end: metadata.duration });
    expect(requiresNarrowerYouTubeRange(state.project)).toBe(false);
  });

  it("keeps a YouTube full-source selection invalid until the range is narrowed", () => {
    let state = editorReducer(createInitialEditorState(), {
      type: "source/youtubeLoaded",
      url: "https://youtu.be/abc123",
      metadata: youtubeMetadata,
    });

    expect(state.project.selection).toEqual({ start: 0, end: youtubeMetadata.duration });
    expect(requiresNarrowerYouTubeRange(state.project)).toBe(true);

    state = editorReducer(state, {
      type: "project/setSelection",
      selection: { start: 1_000_000, end: 119_000_000 },
    });

    expect(requiresNarrowerYouTubeRange(state.project)).toBe(false);
  });

  it("skips and revisits steps without mutating project edits", () => {
    let state = editorReducer(createInitialEditorState(), {
      type: "source/localLoaded",
      path: "C:\\media\\clip.mp4",
      metadata,
    });
    state = editorReducer(state, {
      type: "project/setSelection",
      selection: { start: 10_000_000, end: 80_000_000 },
    });
    const projectBeforeNavigation = state.project;
    const historyBeforeNavigation = state.history;

    state = editorReducer(state, { type: "navigation/goTo", step: "Range" });
    state = editorReducer(state, { type: "navigation/skip" });
    state = editorReducer(state, { type: "navigation/goTo", step: "Range" });

    expect(state.project).toBe(projectBeforeNavigation);
    expect(state.history).toBe(historyBeforeNavigation);
    expect(state.project.selection).toEqual({ start: 10_000_000, end: 80_000_000 });
  });

  it("undoes and redoes project edits without rewinding playhead or source status", () => {
    let state = editorReducer(createInitialEditorState(), {
      type: "source/localLoaded",
      path: "C:\\media\\clip.mp4",
      metadata,
    });
    state = editorReducer(state, {
      type: "project/setQuality",
      quality: "p720",
    });
    state = editorReducer(state, { type: "playhead/set", valueUs: 7_500_000 });
    state = editorReducer(state, {
      type: "source/setStatus",
      status: { kind: "loading", message: "جارٍ الفحص" },
    });

    state = editorReducer(state, { type: "history/undo" });
    expect(state.project.source.downloadQuality).toBe("best");
    expect(state.playheadUs).toBe(7_500_000);
    expect(state.sourceStatus).toEqual({ kind: "loading", message: "جارٍ الفحص" });

    state = editorReducer(state, { type: "history/redo" });
    expect(state.project.source.downloadQuality).toBe("p720");
    expect(state.playheadUs).toBe(7_500_000);
    expect(state.sourceStatus).toEqual({ kind: "loading", message: "جارٍ الفحص" });
  });

  it("caps project edit history at 100 snapshots", () => {
    let state = editorReducer(createInitialEditorState(), {
      type: "source/localLoaded",
      path: "C:\\media\\clip.mp4",
      metadata,
    });

    for (let index = 0; index < 110; index += 1) {
      state = editorReducer(state, {
        type: "project/setQuality",
        quality: index % 2 === 0 ? "p720" : "p1080",
      });
    }

    expect(state.history).toHaveLength(100);
  });

  it("changes quality as a project-only edit without starting a download", () => {
    let state = editorReducer(createInitialEditorState(), {
      type: "source/youtubeLoaded",
      url: "https://youtu.be/abc123",
      metadata: youtubeMetadata,
    });
    const runtimeBefore = {
      activeStep: state.activeStep,
      playheadUs: state.playheadUs,
      sourceStatus: state.sourceStatus,
    };

    state = editorReducer(state, {
      type: "project/setQuality",
      quality: "p1080",
    });

    expect(state.project.source.downloadQuality).toBe("p1080");
    expect({
      activeStep: state.activeStep,
      playheadUs: state.playheadUs,
      sourceStatus: state.sourceStatus,
    }).toEqual(runtimeBefore);
  });
});
