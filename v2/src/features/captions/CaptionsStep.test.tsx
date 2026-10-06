import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CaptionTrack } from "../../app/editorReducer";
import { CaptionsStep } from "./CaptionsStep";

afterEach(cleanup);

const track: CaptionTrack = {
  enabled: true,
  cues: [{ start: 1_000_000, end: 2_500_000, text: "سطر أول\nسطر ثان" }],
  style: {
    sizePercent: 4.5,
    textColor: "#ffffff",
    outlineColor: "#000000",
    outlineWidth: 1.2,
    shadow: 2,
    shadowColor: "#000000",
    backgroundEnabled: false,
    backgroundColor: "#000000",
    backgroundOpacity: 55,
    verticalPosition: "bottom",
    horizontalPosition: "center",
    marginPercent: 7,
    bold: false,
    italic: false,
    fontPath: null,
  },
};

describe("CaptionsStep", () => {
  it("updates style locally and cue click seeks without media processing", async () => {
    const dispatch = vi.fn();
    const onSeek = vi.fn();
    const importCaptions = vi.fn();
    const loadYouTubeCaptions = vi.fn();
    const chooseFont = vi.fn().mockResolvedValue("C:\\Fonts\\Arabic.ttf");

    render(
      <CaptionsStep
        track={track}
        sourceKind="youtube"
        dispatch={dispatch}
        onSeek={onSeek}
        importCaptions={importCaptions}
        loadYouTubeCaptions={loadYouTubeCaptions}
        chooseFont={chooseFont}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /سطر أول/ }));
    expect(onSeek).toHaveBeenCalledWith(1_000_000);

    fireEvent.change(screen.getByLabelText("حجم الكابشن"), { target: { value: "5.5" } });
    expect(dispatch).toHaveBeenCalledWith({
      type: "captions/updateStyle",
      patch: { sizePercent: 5.5 },
    });
    expect(importCaptions).not.toHaveBeenCalled();
    expect(loadYouTubeCaptions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "اختيار خط محلي" }));
    await waitFor(() => expect(chooseFont).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith({
      type: "captions/updateStyle",
      patch: { fontPath: "C:\\Fonts\\Arabic.ttf" },
    });
  });
});
