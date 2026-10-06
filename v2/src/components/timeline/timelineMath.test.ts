import { describe, expect, it } from "vitest";

import {
  clampScrubTime,
  fitViewport,
  moveSelectionHandle,
  panViewport,
  snapTime,
  timeToX,
  xToTime,
  zoomViewport,
} from "./timelineMath";

describe("timelineMath", () => {
  it("maps the full source and zoomed windows without losing microsecond precision", () => {
    const full = fitViewport(120_000_000, 960);
    expect(timeToX(0, full)).toBe(0);
    expect(timeToX(120_000_000, full)).toBe(960);

    const zoomed = { startUs: 10_000_000, endUs: 20_000_000, widthPx: 733 };
    for (const timeUs of [10_000_000, 12_345_678, 19_999_999, 20_000_000]) {
      const roundTrip = xToTime(timeToX(timeUs, zoomed), zoomed);
      expect(Math.abs(roundTrip - timeUs)).toBeLessThanOrEqual(1);
    }
  });

  it("clamps scrubbing and never lets range handles cross", () => {
    const viewport = fitViewport(100_000_000, 1000);
    expect(clampScrubTime(-50, viewport, 100_000_000)).toBe(0);
    expect(clampScrubTime(1200, viewport, 100_000_000)).toBe(100_000_000);

    expect(
      moveSelectionHandle({ start: 20_000_000, end: 80_000_000 }, "start", 90_000_000, 100_000_000),
    ).toEqual({ start: 79_999_999, end: 80_000_000 });
    expect(
      moveSelectionHandle({ start: 20_000_000, end: 80_000_000 }, "end", 10_000_000, 100_000_000),
    ).toEqual({ start: 20_000_000, end: 20_000_001 });
  });

  it("snaps by a fixed pixel threshold rather than a fixed time threshold", () => {
    const viewport = { startUs: 0, endUs: 100_000_000, widthPx: 1000 };
    expect(snapTime(49_650_000, [50_000_000], 5, viewport)).toBe(50_000_000);
    expect(snapTime(49_000_000, [50_000_000], 5, viewport)).toBe(49_000_000);
  });

  it("zooms around the pointer without moving the time under that pointer", () => {
    const viewport = fitViewport(120_000_000, 1200);
    const anchorX = 780;
    const before = xToTime(anchorX, viewport);
    const zoomed = zoomViewport(viewport, 2, anchorX, 120_000_000);
    const after = xToTime(anchorX, zoomed);

    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    expect(zoomed.endUs - zoomed.startUs).toBe(60_000_000);
  });

  it("pans inside the source bounds", () => {
    const viewport = { startUs: 30_000_000, endUs: 60_000_000, widthPx: 600 };
    expect(panViewport(viewport, 400, 100_000_000)).toEqual({
      startUs: 10_000_000,
      endUs: 40_000_000,
      widthPx: 600,
    });
    expect(panViewport(viewport, -2000, 100_000_000)).toEqual({
      startUs: 70_000_000,
      endUs: 100_000_000,
      widthPx: 600,
    });
  });
});
