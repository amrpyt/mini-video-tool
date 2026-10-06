import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";

import type { TimeRange } from "../../lib/types";
import {
  clampScrubTime,
  fitViewport,
  moveSelectionHandle,
  panViewport,
  snapTime,
  timeToX,
  zoomViewport,
  type TimelineViewport,
} from "./timelineMath";

interface TimelineProps {
  durationUs: number;
  selection: TimeRange | null;
  playheadUs: number;
  onPlayheadChange: (timeUs: number) => void;
  onSelectionChange: (selection: TimeRange) => void;
  filmstripUrls?: string[];
}

const LANE_IDS = ["Video", "Filmstrip", "Waveform", "Cuts", "Captions", "Overlays"] as const;

export function Timeline({
  durationUs,
  selection,
  playheadUs,
  onPlayheadChange,
  onSelectionChange,
  filmstripUrls = [],
}: TimelineProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<TimelineViewport>(() => fitViewport(durationUs, 1000));

  useEffect(() => {
    setViewport((current) => fitViewport(durationUs, current.widthPx));
  }, [durationUs]);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const updateWidth = () => {
      const width = Math.max(1, Math.round(element.getBoundingClientRect().width || 1000));
      setViewport((current) => ({ ...current, widthPx: width }));
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const duration = Math.max(0, durationUs);
  const fullStartPercent = selection && duration > 0 ? (selection.start / duration) * 100 : 0;
  const fullEndPercent = selection && duration > 0 ? (selection.end / duration) * 100 : 100;
  const selectionLeft = selection ? timeToX(selection.start, viewport) : 0;
  const selectionRight = selection ? timeToX(selection.end, viewport) : viewport.widthPx;
  const playheadX = timeToX(playheadUs, viewport);

  function surfaceX(clientX: number): number {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return clientX - (rect?.left ?? 0);
  }

  function scrub(clientX: number) {
    onPlayheadChange(clampScrubTime(surfaceX(clientX), viewport, duration));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>, handle: "start" | "end") {
    if (!selection) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const element = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      const raw = clampScrubTime(surfaceX(moveEvent.clientX), viewport, duration);
      const snapped = snapTime(raw, [0, duration, playheadUs], 7, viewport);
      onSelectionChange(moveSelectionHandle(selection, handle, snapped, duration));
    };
    const up = (upEvent: PointerEvent) => {
      element.releasePointerCapture?.(upEvent.pointerId);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  }

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const x = surfaceX(event.clientX);
    if (event.ctrlKey || event.metaKey || event.altKey) {
      const factor = Math.exp(-event.deltaY * 0.002);
      setViewport((current) => zoomViewport(current, factor, x, duration));
      return;
    }
    setViewport((current) => panViewport(current, -(event.deltaX || event.deltaY), duration));
  }

  return (
    <div className="editor-timeline" dir="ltr">
      <div className="timeline-toolbar" dir="rtl">
        <button type="button" className="ghost-button" onClick={() => setViewport(fitViewport(duration, viewport.widthPx))}>
          إظهار المصدر كاملًا
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => setViewport((current) => zoomViewport(current, 1.5, timeToX(playheadUs, current), duration))}
        >
          تكبير
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => setViewport((current) => zoomViewport(current, 1 / 1.5, timeToX(playheadUs, current), duration))}
        >
          تصغير
        </button>
      </div>

      <div
        className="timeline-overview"
        data-testid="timeline-overview"
        data-source-start-us="0"
        data-source-end-us={duration}
      >
        {selection && duration > 0 ? (
          <>
            <span
              data-testid="timeline-outside-selection"
              className="timeline-overview-dim"
              style={{ left: 0, width: `${fullStartPercent}%` }}
            />
            <span
              className="timeline-overview-selection"
              style={{ left: `${fullStartPercent}%`, width: `${Math.max(0, fullEndPercent - fullStartPercent)}%` }}
            />
            <span
              data-testid="timeline-outside-selection"
              className="timeline-overview-dim"
              style={{ left: `${fullEndPercent}%`, right: 0 }}
            />
          </>
        ) : null}
      </div>

      <div
        ref={surfaceRef}
        className="timeline-surface"
        data-testid="timeline-surface"
        onPointerDown={(event) => scrub(event.clientX)}
        onWheel={onWheel}
      >
        <div className="timeline-window" style={{ width: viewport.widthPx }}>
          {selection ? (
            <>
              <span
                className="timeline-selection-window"
                style={{
                  left: Math.max(0, selectionLeft),
                  width: Math.max(0, Math.min(viewport.widthPx, selectionRight) - Math.max(0, selectionLeft)),
                }}
              />
              <button
                type="button"
                className="timeline-range-handle timeline-range-handle-start"
                data-testid="timeline-handle-start"
                aria-label="مقبض بداية التحديد"
                style={{ left: selectionLeft }}
                onPointerDown={(event) => handlePointerDown(event, "start")}
              />
              <button
                type="button"
                className="timeline-range-handle timeline-range-handle-end"
                data-testid="timeline-handle-end"
                aria-label="مقبض نهاية التحديد"
                style={{ left: selectionRight }}
                onPointerDown={(event) => handlePointerDown(event, "end")}
              />
            </>
          ) : null}
          <span className="timeline-source-playhead" style={{ left: playheadX }} />
          {LANE_IDS.map((lane) => (
            <div
              key={lane}
              className={`timeline-lane timeline-lane-${lane.toLowerCase()}`}
              data-testid={`timeline-lane-${lane.toLowerCase()}`}
            >
              <span className="timeline-lane-label">{lane}</span>
              {lane === "Filmstrip" && filmstripUrls.length > 0 ? (
                <div className="timeline-filmstrip">
                  {filmstripUrls.map((url, index) => (
                    <img key={url} src={url} alt={`Filmstrip ${index + 1}`} draggable={false} />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
