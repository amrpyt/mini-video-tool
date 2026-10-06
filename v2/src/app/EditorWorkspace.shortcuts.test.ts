import { describe, expect, it, vi } from "vitest";

import { createInitialEditorState, editorReducer } from "./editorReducer";
import { handleEditorShortcut } from "./EditorWorkspace";

function stateWithSource() {
  let state = createInitialEditorState();
  state = editorReducer(state, {
    type: "source/localLoaded",
    path: "C:\\video.mp4",
    metadata: {
      duration: 10_000_000,
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
      hasAudio: true,
    },
  });
  return editorReducer(state, { type: "playhead/set", valueUs: 2_000_000 });
}

describe("editor keyboard guard", () => {
  it("blocks I/O, frame-step, undo, and redo while typing", () => {
    const state = stateWithSource();
    const dispatch = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.addEventListener("keydown", (event) =>
      handleEditorShortcut(event as KeyboardEvent, state, dispatch),
    );

    for (const init of [
      { key: "i" },
      { key: "o" },
      { key: "ArrowLeft" },
      { key: "ArrowRight" },
      { key: "z", ctrlKey: true },
      { key: "y", ctrlKey: true },
    ]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
    }

    expect(dispatch).not.toHaveBeenCalled();
    input.remove();
  });

  it("keeps shortcuts active when focus is outside an editor input", () => {
    const state = stateWithSource();
    const dispatch = vi.fn();
    const event = new KeyboardEvent("keydown", { key: "i", cancelable: true });
    Object.defineProperty(event, "target", { value: document.body });

    handleEditorShortcut(event, state, dispatch);

    expect(dispatch).toHaveBeenCalledWith({
      type: "project/setSelection",
      selection: { start: 2_000_000, end: 10_000_000 },
    });
  });
});
