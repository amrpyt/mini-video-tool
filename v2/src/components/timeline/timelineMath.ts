import type { TimeRange } from "../../lib/types";

export interface TimelineViewport {
  startUs: number;
  endUs: number;
  widthPx: number;
}

const MIN_VISIBLE_SPAN_US = 1_000;

export function fitViewport(durationUs: number, widthPx: number): TimelineViewport {
  return {
    startUs: 0,
    endUs: Math.max(0, Math.round(durationUs)),
    widthPx: Math.max(1, widthPx),
  };
}

function spanUs(viewport: TimelineViewport): number {
  return Math.max(1, viewport.endUs - viewport.startUs);
}

export function timeToX(timeUs: number, viewport: TimelineViewport): number {
  return ((timeUs - viewport.startUs) / spanUs(viewport)) * viewport.widthPx;
}

export function xToTime(x: number, viewport: TimelineViewport): number {
  return Math.round(viewport.startUs + (x / Math.max(1, viewport.widthPx)) * spanUs(viewport));
}

export function clampScrubTime(
  x: number,
  viewport: TimelineViewport,
  durationUs: number,
): number {
  return clamp(xToTime(x, viewport), 0, Math.max(0, Math.round(durationUs)));
}

export function moveSelectionHandle(
  selection: TimeRange,
  handle: "start" | "end",
  targetUs: number,
  durationUs: number,
): TimeRange {
  const duration = Math.max(1, Math.round(durationUs));
  const target = clamp(Math.round(targetUs), 0, duration);
  if (handle === "start") {
    return { start: Math.min(target, selection.end - 1), end: selection.end };
  }
  return { start: selection.start, end: Math.max(target, selection.start + 1) };
}

export function snapTime(
  timeUs: number,
  boundariesUs: readonly number[],
  thresholdPx: number,
  viewport: TimelineViewport,
): number {
  const targetX = timeToX(timeUs, viewport);
  let best = timeUs;
  let bestDistance = Math.max(0, thresholdPx) + Number.EPSILON;
  for (const boundary of boundariesUs) {
    const distance = Math.abs(timeToX(boundary, viewport) - targetX);
    if (distance <= thresholdPx && distance < bestDistance) {
      best = boundary;
      bestDistance = distance;
    }
  }
  return Math.round(best);
}

export function zoomViewport(
  viewport: TimelineViewport,
  factor: number,
  anchorX: number,
  durationUs: number,
): TimelineViewport {
  const duration = Math.max(0, Math.round(durationUs));
  if (duration <= 0) return fitViewport(0, viewport.widthPx);
  const oldSpan = Math.min(duration, spanUs(viewport));
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const newSpan = clamp(Math.round(oldSpan / safeFactor), MIN_VISIBLE_SPAN_US, duration);
  if (newSpan >= duration) return fitViewport(duration, viewport.widthPx);

  const width = Math.max(1, viewport.widthPx);
  const clampedAnchorX = clamp(anchorX, 0, width);
  const ratio = clampedAnchorX / width;
  const anchorTime = viewport.startUs + ratio * oldSpan;
  let startUs = Math.round(anchorTime - ratio * newSpan);
  startUs = clamp(startUs, 0, duration - newSpan);
  return { startUs, endUs: startUs + newSpan, widthPx: width };
}

export function panViewport(
  viewport: TimelineViewport,
  deltaPx: number,
  durationUs: number,
): TimelineViewport {
  const duration = Math.max(0, Math.round(durationUs));
  const span = Math.min(duration || spanUs(viewport), spanUs(viewport));
  if (duration <= span) return fitViewport(duration, viewport.widthPx);
  const shiftUs = Math.round((-deltaPx / Math.max(1, viewport.widthPx)) * span);
  const startUs = clamp(viewport.startUs + shiftUs, 0, duration - span);
  return { startUs, endUs: startUs + span, widthPx: Math.max(1, viewport.widthPx) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
