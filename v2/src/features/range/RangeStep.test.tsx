import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialEditorState, editorReducer } from "../../app/editorReducer";
import { RangeStep } from "./RangeStep";

afterEach(cleanup);

describe("RangeStep accessibility", () => {
  it("keeps timestamp editing LTR inside the RTL editor", () => {
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

    render(
      <div dir="rtl">
        <RangeStep state={state} dispatch={vi.fn()} />
      </div>,
    );

    expect(screen.getByLabelText("البداية")).toHaveAttribute("dir", "ltr");
    expect(screen.getByLabelText("النهاية")).toHaveAttribute("dir", "ltr");
  });
});
