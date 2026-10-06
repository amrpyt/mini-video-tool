import { convertFileSrc } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { useEffect, useRef, useState } from "react";

import type { EditorSource } from "../app/editorReducer";
import { extractPreviewFrame } from "../lib/backend";

interface PreviewProps {
  source: EditorSource;
  playheadUs: number;
  requestStillFrame?: (sourcePath: string, timestampUs: number) => Promise<string>;
  toAssetUrl?: (path: string) => string;
}

export function Preview({
  source,
  playheadUs,
  requestStillFrame = requestDefaultStillFrame,
  toAssetUrl = convertFileSrc,
}: PreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [nativeFailed, setNativeFailed] = useState(false);
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const [requestingStill, setRequestingStill] = useState(false);

  const sourceKey = source.kind === "local" ? source.path : source.kind === "youtube" ? source.url : "none";
  useEffect(() => {
    setNativeFailed(false);
    setStillUrl(null);
    setRequestingStill(false);
  }, [sourceKey]);

  useEffect(() => {
    if (source.kind !== "local" || nativeFailed || !videoRef.current) return;
    const desiredSeconds = Math.max(0, playheadUs) / 1_000_000;
    if (Math.abs(videoRef.current.currentTime - desiredSeconds) > 0.001) {
      videoRef.current.currentTime = desiredSeconds;
    }
  }, [nativeFailed, playheadUs, source]);

  async function onNativeError() {
    if (source.kind !== "local" || nativeFailed || requestingStill) return;
    setNativeFailed(true);
    setRequestingStill(true);
    try {
      setStillUrl(await requestStillFrame(source.path, playheadUs));
    } finally {
      setRequestingStill(false);
    }
  }

  if (source.kind === "youtube") {
    return (
      <div className="preview-media-shell">
        {source.metadata.thumbnailUrl ? (
          <img className="preview-poster" src={source.metadata.thumbnailUrl} alt="معاينة فيديو يوتيوب" />
        ) : (
          <div className="preview-empty">لا توجد صورة معاينة متاحة</div>
        )}
        <div className="preview-youtube-caption">
          <strong>{source.metadata.title}</strong>
          <span>بيانات وصورة فقط قبل تنزيل الجزء المحدد</span>
        </div>
      </div>
    );
  }

  if (source.kind === "local") {
    return (
      <div className="preview-media-shell">
        {nativeFailed ? (
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
        <div className="preview-overlay-layer" data-testid="preview-overlay-layer" aria-hidden="true" />
      </div>
    );
  }

  return <div className="preview-empty">اختر مصدرًا لبدء المعاينة</div>;
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
