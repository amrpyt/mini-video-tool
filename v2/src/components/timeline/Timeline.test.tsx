import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Timeline } from "./Timeline";

afterEach(cleanup);

describe("Timeline", () => {
  it("keeps full-source context visible and exposes all initial editor lanes", () => {
    render(
      <Timeline
        durationUs={100_000_000}
        selection={{ start: 20_000_000, end: 80_000_000 }}
        playheadUs={30_000_000}
        onPlayheadChange={() => undefined}
        onSelectionChange={() => undefined}
        filmstripUrls={["asset://frame-1.jpg", "asset://frame-2.jpg"]}
      />,
    );

    expect(screen.getByTestId("timeline-overview")).toHaveAttribute("data-source-start-us", "0");
    expect(screen.getByTestId("timeline-overview")).toHaveAttribute("data-source-end-us", "100000000");
    expect(screen.getAllByTestId("timeline-outside-selection")).toHaveLength(2);
    for (const lane of ["Video", "Filmstrip", "Waveform", "Cuts", "Captions", "Overlays"]) {
      expect(screen.getByTestId(`timeline-lane-${lane.toLowerCase()}`)).toBeInTheDocument();
    }
  });

  it("scrubs and moves handles locally without any media backend dependency", () => {
    const onPlayheadChange = vi.fn();
    const onSelectionChange = vi.fn();
    render(
      <Timeline
        durationUs={100_000_000}
        selection={{ start: 20_000_000, end: 80_000_000 }}
        playheadUs={30_000_000}
        onPlayheadChange={onPlayheadChange}
        onSelectionChange={onSelectionChange}
      />,
    );

    const surface = screen.getByTestId("timeline-surface");
    Object.defineProperty(surface, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 1000, bottom: 240, width: 1000, height: 240, x: 0, y: 0, toJSON: () => ({}) }),
    });

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 500 });
    expect(onPlayheadChange).toHaveBeenCalledWith(50_000_000);

    const startHandle = screen.getByTestId("timeline-handle-start");
    Object.defineProperty(startHandle, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(startHandle, "releasePointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(startHandle, { pointerId: 2, clientX: 200 });
    fireEvent.pointerMove(startHandle, { pointerId: 2, clientX: 400 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 40_000_000, end: 80_000_000 });
  });
});
