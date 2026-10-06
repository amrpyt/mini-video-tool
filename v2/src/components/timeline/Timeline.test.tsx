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
        filmstripFrames={[
          { url: "asset://frame-1.jpg", timeUs: 0 },
          { url: "asset://frame-2.jpg", timeUs: 50_000_000 },
        ]}
      />,
    );

    expect(screen.getByTestId("timeline-overview")).toHaveAttribute("data-source-start-us", "0");
    expect(screen.getByTestId("timeline-overview")).toHaveAttribute("data-source-end-us", "100000000");
    expect(screen.getAllByTestId("timeline-outside-selection")).toHaveLength(2);
    for (const lane of ["Video", "Filmstrip", "Waveform", "Cuts", "Captions", "Overlays"]) {
      expect(screen.getByTestId(`timeline-lane-${lane.toLowerCase()}`)).toBeInTheDocument();
    }
  });

  it("maps filmstrip frames to source time and keeps them aligned after zoom", () => {
    render(
      <Timeline
        durationUs={100_000_000}
        selection={{ start: 20_000_000, end: 80_000_000 }}
        playheadUs={50_000_000}
        onPlayheadChange={() => undefined}
        onSelectionChange={() => undefined}
        filmstripFrames={[
          { url: "asset://frame-0.jpg", timeUs: 0 },
          { url: "asset://frame-25.jpg", timeUs: 25_000_000 },
          { url: "asset://frame-50.jpg", timeUs: 50_000_000 },
          { url: "asset://frame-75.jpg", timeUs: 75_000_000 },
        ]}
      />,
    );

    const frame25 = screen.getByTestId("filmstrip-frame-25000000");
    expect(frame25).toHaveStyle({ left: "250px" });
    expect(screen.getByTestId("filmstrip-frame-0")).toHaveStyle({ left: "0px" });

    fireEvent.click(screen.getByRole("button", { name: "تكبير" }));

    expect(screen.queryByTestId("filmstrip-frame-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("filmstrip-frame-25000000")).toHaveStyle({ left: "125px" });
    expect(screen.getByTestId("filmstrip-frame-50000000")).toHaveStyle({ left: "500px" });
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

  it("renders waveform and detected/accepted cuts in source-time coordinates", () => {
    render(
      <Timeline
        durationUs={100_000_000}
        selection={{ start: 10_000_000, end: 90_000_000 }}
        playheadUs={20_000_000}
        onPlayheadChange={() => undefined}
        onSelectionChange={() => undefined}
        waveformUrl="asset://wave.png"
        waveformRange={{ start: 10_000_000, end: 90_000_000 }}
        detectedRegions={[{ start: 20_000_000, end: 30_000_000 }]}
        acceptedRegions={[{ start: 22_000_000, end: 28_000_000 }]}
      />,
    );

    expect(screen.getByTestId("timeline-waveform-image")).toHaveStyle({
      left: "100px",
      width: "800px",
    });
    expect(screen.getByTestId("timeline-detected-region")).toHaveStyle({
      left: "200px",
      width: "100px",
    });
    expect(screen.getByTestId("timeline-accepted-region")).toHaveStyle({
      left: "220px",
      width: "60px",
    });
  });
});
