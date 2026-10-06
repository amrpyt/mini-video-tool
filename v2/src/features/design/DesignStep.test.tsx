import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Preview } from "../../components/Preview";
import type { EditorOverlay } from "../../app/editorReducer";
import { DesignStep } from "./DesignStep";

afterEach(cleanup);

const overlay: EditorOverlay = {
  id: "overlay-1",
  kind: "blackBar",
  range: { start: 0, end: 10_000_000 },
  geometry: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
  opacity: 0.8,
  assetPath: null,
  aspectLocked: true,
};

describe("DesignStep", () => {
  it("updates opacity and aspect lock as project actions only", () => {
    const dispatch = vi.fn();
    render(
      <DesignStep
        selection={{ start: 0, end: 10_000_000 }}
        overlays={[overlay]}
        selectedOverlayId={overlay.id}
        onSelectOverlay={() => undefined}
        dispatch={dispatch}
        chooseImage={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("الشفافية"), { target: { value: "0.55" } });
    expect(dispatch).toHaveBeenCalledWith({
      type: "overlay/updateOpacity",
      id: overlay.id,
      opacity: 0.55,
    });

    fireEvent.click(screen.getByLabelText("تثبيت النسبة"));
    expect(dispatch).toHaveBeenCalledWith({
      type: "overlay/setAspectLock",
      id: overlay.id,
      locked: false,
    });
  });

  it("moves overlay in the live preview and shows guides without a media backend call", () => {
    const onGeometryChange = vi.fn();
    render(
      <Preview
        source={{
          kind: "local",
          path: "C:\\video\\clip.mp4",
          downloadQuality: "best",
          metadata: {
            duration: 10_000_000,
            width: 1920,
            height: 1080,
            frameRate: { numerator: 30, denominator: 1 },
            hasAudio: true,
          },
        }}
        playheadUs={5_000_000}
        overlays={[overlay]}
        selectedOverlayId={overlay.id}
        onOverlayGeometryChange={onGeometryChange}
        requestStillFrame={vi.fn()}
        toAssetUrl={(path) => path}
      />,
    );

    const layer = screen.getByTestId("preview-overlay-layer");
    Object.defineProperty(layer, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        width: 1000,
        height: 500,
        right: 1000,
        bottom: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    const item = screen.getByTestId("preview-overlay-overlay-1");
    Object.defineProperty(item, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(item, "releasePointerCapture", { value: vi.fn() });

    fireEvent.pointerDown(item, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(screen.getByTestId("preview-safe-guides")).toBeInTheDocument();
    expect(screen.getByTestId("preview-alignment-guides")).toBeInTheDocument();
    fireEvent.pointerMove(item, { pointerId: 1, clientX: 200, clientY: 150 });
    expect(onGeometryChange).toHaveBeenLastCalledWith(overlay.id, {
      x: 0.2,
      y: 0.2,
      width: 0.3,
      height: 0.2,
    });
    fireEvent.pointerUp(item, { pointerId: 1, clientX: 200, clientY: 150 });
    expect(screen.queryByTestId("preview-safe-guides")).not.toBeInTheDocument();

    const resize = screen.getByRole("button", { name: "تغيير حجم العنصر" });
    Object.defineProperty(resize, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(resize, "releasePointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(resize, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(resize, { pointerId: 2, clientX: 500, clientY: 250 });
    const [, resized] = onGeometryChange.mock.calls.at(-1) as [string, typeof overlay.geometry];
    expect(resized.x).toBe(0.1);
    expect(resized.y).toBe(0.1);
    expect(resized.width).toBeGreaterThan(overlay.geometry.width);
    expect(resized.height).toBeGreaterThan(overlay.geometry.height);
    expect(resized.width / resized.height).toBeCloseTo(
      overlay.geometry.width / overlay.geometry.height,
      6,
    );
    fireEvent.pointerUp(resize, { pointerId: 2, clientX: 500, clientY: 250 });
  });
});
