import { convertFileSrc } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { EditorSource } from "../app/editorReducer";
import {
  moveGeometry,
  pixelsToNormalizedDelta,
  resizeGeometry,
} from "../features/design/overlayGeometry";
import { extractPreviewFrame } from "../lib/backend";
import type {
  CaptionTrack,
  EditorOverlay,
  NormalizedGeometry,
} from "../lib/types";

interface PreviewProps {
  source: EditorSource;
  playheadUs: number;
  mediaPlayheadUs?: number;
  overlays?: EditorOverlay[];
  captionTrack?: CaptionTrack | null;
  selectedOverlayId?: string | null;
  onSelectOverlay?: (id: string | null) => void;
  onOverlayGeometryChange?: (id: string, geometry: NormalizedGeometry) => void;
  requestStillFrame?: (sourcePath: string, timestampUs: number) => Promise<string>;
  toAssetUrl?: (path: string) => string;
}

interface OverlayInteraction {
  pointerId: number;
  overlayId: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  geometry: NormalizedGeometry;
  aspectRatio?: number;
  captureElement: HTMLElement;
}

export function Preview({
  source,
  playheadUs,
  mediaPlayheadUs = playheadUs,
  overlays = [],
  captionTrack = null,
  selectedOverlayId = null,
  onSelectOverlay,
  onOverlayGeometryChange,
  requestStillFrame = requestDefaultStillFrame,
  toAssetUrl = convertFileSrc,
}: PreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const overlayLayerRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<OverlayInteraction | null>(null);
  const [nativeFailed, setNativeFailed] = useState(false);
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const [requestingStill, setRequestingStill] = useState(false);
  const [manipulatingOverlayId, setManipulatingOverlayId] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  const sourceKey = source.kind === "local" ? source.path : source.kind === "youtube" ? source.url : "none";
  useEffect(() => {
    setNativeFailed(false);
    setStillUrl(null);
    setRequestingStill(false);
  }, [sourceKey]);

  const sourceAspectRatio =
    source.kind === "local" && source.metadata.height > 0
      ? source.metadata.width / source.metadata.height
      : 16 / 9;

  useEffect(() => {
    const element = shellRef.current;
    if (!element) return;
    const updateFrameSize = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const shellAspect = bounds.width / bounds.height;
      if (shellAspect > sourceAspectRatio) {
        setFrameSize({ width: bounds.height * sourceAspectRatio, height: bounds.height });
      } else {
        setFrameSize({ width: bounds.width, height: bounds.width / sourceAspectRatio });
      }
    };
    updateFrameSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateFrameSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sourceAspectRatio]);

  useEffect(() => {
    if (source.kind !== "local" || nativeFailed || !videoRef.current) return;
    const desiredSeconds = Math.max(0, mediaPlayheadUs) / 1_000_000;
    if (Math.abs(videoRef.current.currentTime - desiredSeconds) > 0.001) {
      videoRef.current.currentTime = desiredSeconds;
    }
  }, [mediaPlayheadUs, nativeFailed, source]);

  useEffect(() => {
    const fontPath = captionTrack?.style.fontPath;
    if (!fontPath || typeof FontFace === "undefined") return;
    let disposed = false;
    let loadedFace: FontFace | null = null;
    const face = new FontFace("MVTCustomCaption", `url("${toAssetUrl(fontPath)}")`);
    void face
      .load()
      .then((loaded) => {
        if (disposed) return;
        loadedFace = loaded;
        document.fonts.add(loaded);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (loadedFace) document.fonts.delete(loadedFace);
    };
  }, [captionTrack?.style.fontPath, toAssetUrl]);

  async function onNativeError() {
    if (source.kind !== "local" || nativeFailed || requestingStill) return;
    setNativeFailed(true);
    setRequestingStill(true);
    try {
      setStillUrl(await requestStillFrame(source.path, mediaPlayheadUs));
    } finally {
      setRequestingStill(false);
    }
  }

  function startOverlayInteraction(
    event: ReactPointerEvent<HTMLElement>,
    overlay: EditorOverlay,
    mode: "move" | "resize",
  ) {
    event.preventDefault();
    event.stopPropagation();
    onSelectOverlay?.(overlay.id);
    if (!onOverlayGeometryChange) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    interactionRef.current = {
      pointerId: event.pointerId,
      overlayId: overlay.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      geometry: { ...overlay.geometry },
      aspectRatio: overlay.aspectLocked
        ? overlay.geometry.width / Math.max(0.000001, overlay.geometry.height)
        : undefined,
      captureElement: event.currentTarget,
    };
    setManipulatingOverlayId(overlay.id);
  }

  function moveOverlayInteraction(event: ReactPointerEvent<HTMLElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId || !onOverlayGeometryChange) return;
    const bounds = overlayLayerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const delta = pixelsToNormalizedDelta(
      event.clientX - interaction.startX,
      event.clientY - interaction.startY,
      bounds.width,
      bounds.height,
    );
    const geometry =
      interaction.mode === "move"
        ? moveGeometry(interaction.geometry, delta)
        : resizeGeometry(interaction.geometry, delta, interaction.aspectRatio);
    onOverlayGeometryChange(interaction.overlayId, geometry);
  }

  function stopOverlayInteraction(event: ReactPointerEvent<HTMLElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    interaction.captureElement.releasePointerCapture?.(event.pointerId);
    interactionRef.current = null;
    setManipulatingOverlayId(null);
  }

  if (source.kind === "none") {
    return <div className="preview-empty">اختر مصدرًا لبدء المعاينة</div>;
  }

  const activeOverlays = overlays.filter(
    (overlay) => playheadUs >= overlay.range.start && playheadUs < overlay.range.end,
  );
  const activeCues =
    captionTrack?.enabled
      ? captionTrack.cues.filter((cue) => playheadUs >= cue.start && playheadUs < cue.end)
      : [];

  return (
    <div ref={shellRef} className="preview-media-shell">
      <div
        className="preview-frame"
        style={
          frameSize
            ? { width: frameSize.width, height: frameSize.height }
            : { width: "100%", height: "100%" }
        }
      >
      {source.kind === "youtube" ? (
        <>
          {source.metadata.thumbnailUrl ? (
            <img className="preview-poster" src={source.metadata.thumbnailUrl} alt="معاينة فيديو يوتيوب" />
          ) : (
            <div className="preview-empty">لا توجد صورة معاينة متاحة</div>
          )}
          <div className="preview-youtube-caption">
            <strong>{source.metadata.title}</strong>
            <span>بيانات وصورة فقط قبل تنزيل الجزء المحدد</span>
          </div>
        </>
      ) : nativeFailed ? (
        stillUrl ? (
          <img className="preview-poster" src={stillUrl} alt="إطار معاينة ثابت" />
        ) : (
          <div className="preview-empty">{requestingStill ? "جاري تجهيز إطار معاينة خفيف…" : "تعذر تشغيل الفيديو مباشرة"}</div>
        )
      ) : (
        <video
          ref={videoRef}
          className="preview-video"
          data-testid="native-preview-video"
          src={toAssetUrl(source.path)}
          preload="metadata"
          controls
          onError={onNativeError}
        />
      )}

      <div
        ref={overlayLayerRef}
        className="preview-overlay-layer"
        data-testid="preview-overlay-layer"
        onPointerMove={moveOverlayInteraction}
        onPointerUp={stopOverlayInteraction}
        onPointerCancel={stopOverlayInteraction}
      >
        {manipulatingOverlayId ? (
          <>
            <div className="preview-safe-guides" data-testid="preview-safe-guides" />
            <div className="preview-alignment-guides" data-testid="preview-alignment-guides">
              <span className="preview-guide-vertical" />
              <span className="preview-guide-horizontal" />
            </div>
          </>
        ) : null}
        {activeOverlays.map((overlay) => (
          <div
            key={overlay.id}
            className={
              overlay.id === selectedOverlayId
                ? "preview-overlay-item selected"
                : "preview-overlay-item"
            }
            data-testid={`preview-overlay-${overlay.id}`}
            style={{
              left: `${overlay.geometry.x * 100}%`,
              top: `${overlay.geometry.y * 100}%`,
              width: `${overlay.geometry.width * 100}%`,
              height: `${overlay.geometry.height * 100}%`,
              opacity: overlay.opacity,
            }}
            onPointerDown={(event) => startOverlayInteraction(event, overlay, "move")}
          >
            {overlay.kind === "image" && overlay.assetPath ? (
              <img src={toAssetUrl(overlay.assetPath)} alt="" draggable={false} />
            ) : (
              <div className="preview-black-bar" />
            )}
            {overlay.id === selectedOverlayId ? (
              <button
                type="button"
                className="preview-overlay-resize-handle"
                aria-label="تغيير حجم العنصر"
                onPointerDown={(event) => startOverlayInteraction(event, overlay, "resize")}
              />
            ) : null}
          </div>
        ))}
      </div>

      {captionTrack?.enabled && activeCues.length > 0 ? (
        <div
          className={`preview-caption-layer caption-${captionTrack.style.verticalPosition} caption-${captionTrack.style.horizontalPosition}`}
          data-testid="preview-caption-layer"
          style={{
            direction: "ltr",
            paddingTop:
              captionTrack.style.verticalPosition === "top"
                ? `${captionTrack.style.marginPercent}cqh`
                : undefined,
            paddingBottom:
              captionTrack.style.verticalPosition === "bottom"
                ? `${captionTrack.style.marginPercent}cqh`
                : undefined,
          }}
        >
          <div
            className="preview-caption-text"
            style={{
              color: captionTrack.style.textColor,
              fontSize: `clamp(12px, ${captionTrack.style.sizePercent}cqh, 96px)`,
              fontWeight: captionTrack.style.bold ? 700 : 400,
              fontStyle: captionTrack.style.italic ? "italic" : "normal",
              fontFamily: captionTrack.style.fontPath ? "MVTCustomCaption, sans-serif" : "sans-serif",
              WebkitTextStroke: `${captionTrack.style.outlineWidth}px ${captionTrack.style.outlineColor}`,
              textShadow: `0 ${captionTrack.style.shadow}px ${captionTrack.style.shadow}px ${captionTrack.style.shadowColor}`,
              background: captionTrack.style.backgroundEnabled
                ? hexToRgba(
                    captionTrack.style.backgroundColor,
                    captionTrack.style.backgroundOpacity / 100,
                  )
                : "transparent",
            }}
          >
            {activeCues.map((cue, index) => (
              <span key={`${cue.start}-${cue.end}-${index}`} dir="auto">
                {cue.text.split("\n").map((line, lineIndex) => (
                  <span key={lineIndex}>
                    {lineIndex > 0 ? <br /> : null}
                    {line}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}

async function requestDefaultStillFrame(sourcePath: string, timestampUs: number): Promise<string> {
  const cacheRoot = await appCacheDir();
  const destination = await join(cacheRoot, "mini-video-tool-v2", "preview", "frame.jpg");
  const path = await extractPreviewFrame({
    source: sourcePath,
    timestamp: timestampUs,
    destination,
  });
  return convertFileSrc(path);
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`;
}
