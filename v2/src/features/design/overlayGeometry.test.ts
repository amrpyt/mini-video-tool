import { describe, expect, it } from "vitest";

import {
  clampGeometry,
  moveGeometry,
  pixelsToNormalizedDelta,
  resizeGeometry,
} from "./overlayGeometry";

describe("overlayGeometry", () => {
  it("clamps normalized geometry inside the preview", () => {
    expect(clampGeometry({ x: -0.2, y: 0.9, width: 0.4, height: 0.3 })).toEqual({
      x: 0,
      y: 0.7,
      width: 0.4,
      height: 0.3,
    });
  });

  it("preserves aspect ratio while fitting inside bounds", () => {
    const geometry = clampGeometry(
      { x: 0.8, y: 0.8, width: 0.4, height: 0.3 },
      16 / 9,
    );
    expect(geometry.x).toBeCloseTo(0.8, 6);
    expect(geometry.y).toBeCloseTo(0.8, 6);
    expect(geometry.width).toBeCloseTo(0.2, 6);
    expect(geometry.height).toBeCloseTo(0.1125, 6);
  });

  it("moves and resizes in normalized coordinates independent of preview size", () => {
    const first = pixelsToNormalizedDelta(100, 50, 1000, 500);
    const second = pixelsToNormalizedDelta(200, 100, 2000, 1000);
    expect(first).toEqual(second);
    expect(first).toEqual({ x: 0.1, y: 0.1 });

    expect(
      moveGeometry({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, first),
    ).toEqual({ x: 0.3, y: 0.3, width: 0.3, height: 0.3 });

    const resized = resizeGeometry(
      { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
      { x: 0.2, y: 0.2 },
      1.5,
    );
    expect(resized.width / resized.height).toBeCloseTo(1.5, 6);
    expect(resized.x + resized.width).toBeLessThanOrEqual(1);
    expect(resized.y + resized.height).toBeLessThanOrEqual(1);
  });
});
