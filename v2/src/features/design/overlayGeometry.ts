import type { NormalizedGeometry } from "../../lib/types";

export interface NormalizedDelta {
  x: number;
  y: number;
}

const MIN_SIZE = 0.01;

export function pixelsToNormalizedDelta(
  deltaX: number,
  deltaY: number,
  previewWidth: number,
  previewHeight: number,
): NormalizedDelta {
  return {
    x: deltaX / Math.max(1, previewWidth),
    y: deltaY / Math.max(1, previewHeight),
  };
}

export function clampGeometry(
  geometry: NormalizedGeometry,
  aspectRatio?: number,
): NormalizedGeometry {
  let width = clamp(geometry.width, MIN_SIZE, 1);
  let height = clamp(geometry.height, MIN_SIZE, 1);
  let x = clamp(geometry.x, 0, 1 - MIN_SIZE);
  let y = clamp(geometry.y, 0, 1 - MIN_SIZE);

  if (aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0) {
    const availableWidth = Math.max(MIN_SIZE, 1 - x);
    const availableHeight = Math.max(MIN_SIZE, 1 - y);
    width = Math.min(width, availableWidth);
    height = width / aspectRatio;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * aspectRatio;
    }
    if (height < MIN_SIZE) {
      height = Math.min(MIN_SIZE, availableHeight);
      width = Math.min(availableWidth, height * aspectRatio);
    }
  } else {
    x = clamp(x, 0, 1 - width);
    y = clamp(y, 0, 1 - height);
  }

  return {
    x: normalized(clamp(x, 0, Math.max(0, 1 - width))),
    y: normalized(clamp(y, 0, Math.max(0, 1 - height))),
    width: normalized(width),
    height: normalized(height),
  };
}

export function moveGeometry(
  geometry: NormalizedGeometry,
  delta: NormalizedDelta,
): NormalizedGeometry {
  return clampGeometry({
    ...geometry,
    x: geometry.x + delta.x,
    y: geometry.y + delta.y,
  });
}

export function resizeGeometry(
  geometry: NormalizedGeometry,
  delta: NormalizedDelta,
  aspectRatio?: number,
): NormalizedGeometry {
  if (aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0) {
    const denominator = geometry.width * geometry.width + geometry.height * geometry.height;
    const projectedScale =
      denominator > 0
        ? 1 + (delta.x * geometry.width + delta.y * geometry.height) / denominator
        : 1;
    const minimumScale = Math.max(
      MIN_SIZE / Math.max(MIN_SIZE, geometry.width),
      MIN_SIZE / Math.max(MIN_SIZE, geometry.height),
    );
    const scale = Math.max(minimumScale, projectedScale);
    return clampGeometry(
      {
        ...geometry,
        width: Math.max(MIN_SIZE, geometry.width * scale),
        height: Math.max(MIN_SIZE, geometry.height * scale),
      },
      aspectRatio,
    );
  }

  return clampGeometry({
    ...geometry,
    width: geometry.width + delta.x,
    height: geometry.height + delta.y,
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalized(value: number): number {
  return Number(value.toFixed(12));
}
