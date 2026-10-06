import { describe, expect, it } from "vitest";

import { createInitialEditorState, editorReducer } from "./editorReducer";
import { fromProjectDocument, toProjectDocument } from "./projectDocument";

describe("project document conversion", () => {
  it("round-trips YouTube intent and a resolved partial with source offset", () => {
    let state = createInitialEditorState();
    state = editorReducer(state, {
      type: "source/youtubeLoaded",
      url: "https://youtu.be/demo",
      metadata: {
        videoId: "demo",
        title: "Demo",
        duration: 60_000_000,
        thumbnailUrl: "https://example.test/thumb.jpg",
        qualities: ["best", "p720"],
      },
    });
    state = editorReducer(state, {
      type: "project/setSelection",
      selection: { start: 10_000_000, end: 20_000_000 },
    });
    const resolved = {
      path: "C:\\cache\\partial.webm",
      sourceOffset: 9_500_000,
      metadata: {
        duration: 10_500_000,
        width: 1280,
        height: 720,
        frameRate: { numerator: 30, denominator: 1 },
        hasAudio: true,
      },
    };

    const document = toProjectDocument(state.project, resolved);
    expect(document.source.url).toBe("https://youtu.be/demo");
    expect(document.source.resolvedPath).toBe(resolved.path);
    expect(document.source.sourceOffset).toBe(9_500_000);

    const hydrated = fromProjectDocument(document);
    expect(hydrated.project).toEqual(state.project);
    expect(hydrated.resolvedYouTube).toEqual(resolved);
  });
});
