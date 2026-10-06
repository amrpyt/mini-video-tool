import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

import type { EditorAction, EditorState } from "../../app/editorReducer";
import { requiresNarrowerYouTubeRange } from "../../app/editorReducer";
import { getYouTubeMetadata, probeSource } from "../../lib/backend";
import type { DownloadQuality } from "../../lib/types";

interface SourceStepProps {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
}

const QUALITY_OPTIONS: Array<{ value: DownloadQuality; label: string }> = [
  { value: "best", label: "Best" },
  { value: "p1080", label: "1080p" },
  { value: "p720", label: "720p" },
  { value: "p480", label: "480p" },
  { value: "p360", label: "360p" },
];

export function SourceStep({ state, dispatch }: SourceStepProps) {
  const [localPath, setLocalPath] = useState(
    state.project.source.kind === "local" ? state.project.source.path : "",
  );
  const [youtubeUrl, setYoutubeUrl] = useState(
    state.project.source.kind === "youtube" ? state.project.source.url : "",
  );

  async function inspectLocalPath(inputPath: string) {
    const path = inputPath.trim();
    if (!path) {
      dispatch({ type: "source/setStatus", status: { kind: "error", message: "اكتب مسار الفيديو المحلي" } });
      return;
    }
    dispatch({ type: "source/setStatus", status: { kind: "loading", message: "جارٍ فحص الملف…" } });
    try {
      const metadata = await probeSource(path);
      dispatch({ type: "source/localLoaded", path, metadata });
    } catch (error) {
      dispatch({
        type: "source/setStatus",
        status: { kind: "error", message: error instanceof Error ? error.message : "تعذر فحص الملف" },
      });
    }
  }

  async function inspectLocal() {
    await inspectLocalPath(localPath);
  }

  async function chooseLocal() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi", "ts"],
        },
      ],
    });
    if (typeof selected !== "string") return;
    setLocalPath(selected);
    await inspectLocalPath(selected);
  }

  async function inspectYouTube() {
    const url = youtubeUrl.trim();
    if (!url) {
      dispatch({ type: "source/setStatus", status: { kind: "error", message: "اكتب رابط يوتيوب" } });
      return;
    }
    dispatch({ type: "source/setStatus", status: { kind: "loading", message: "جارٍ قراءة بيانات الفيديو…" } });
    try {
      const metadata = await getYouTubeMetadata(url);
      dispatch({ type: "source/youtubeLoaded", url, metadata });
    } catch (error) {
      dispatch({
        type: "source/setStatus",
        status: { kind: "error", message: error instanceof Error ? error.message : "تعذر قراءة بيانات يوتيوب" },
      });
    }
  }

  const source = state.project.source;
  const availableQualities = source.kind === "youtube" ? source.metadata.qualities : [];

  return (
    <div className="step-form source-step">
      <section className="form-section">
        <h2>ملف محلي</h2>
        <label htmlFor="local-source-path">مسار الفيديو</label>
        <input
          id="local-source-path"
          className="path-input"
          dir="ltr"
          value={localPath}
          onChange={(event) => setLocalPath(event.target.value)}
          placeholder="C:\\Videos\\clip.mp4"
        />
        <div className="source-file-actions">
          <button type="button" className="primary-button" onClick={chooseLocal}>
            اختيار ملف فيديو
          </button>
          <button type="button" className="secondary-button" onClick={inspectLocal}>
            فحص المسار المكتوب
          </button>
        </div>
      </section>

      <div className="section-divider" role="separator" />

      <section className="form-section">
        <h2>يوتيوب</h2>
        <label htmlFor="youtube-source-url">رابط الفيديو</label>
        <input
          id="youtube-source-url"
          className="path-input"
          dir="ltr"
          value={youtubeUrl}
          onChange={(event) => setYoutubeUrl(event.target.value)}
          placeholder="https://youtu.be/…"
        />
        <button type="button" className="primary-button" onClick={inspectYouTube}>
          قراءة البيانات فقط
        </button>
      </section>

      {source.kind === "youtube" ? (
        <section className="source-card" aria-label="بيانات يوتيوب">
          {source.metadata.thumbnailUrl ? (
            <img src={source.metadata.thumbnailUrl} alt="صورة الفيديو" className="source-poster" />
          ) : null}
          <strong>{source.metadata.title}</strong>
          <span>{formatDuration(source.metadata.duration)}</span>
          <label htmlFor="download-quality">جودة التحميل</label>
          <select
            id="download-quality"
            value={source.downloadQuality}
            onChange={(event) =>
              dispatch({
                type: "project/setQuality",
                quality: event.target.value as DownloadQuality,
              })
            }
          >
            {QUALITY_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.value !== "best" && !availableQualities.includes(option.value)}
              >
                {option.label}
              </option>
            ))}
          </select>
          {requiresNarrowerYouTubeRange(state.project) ? (
            <p className="field-warning" role="status">
              لازم تحدد جزء أصغر من الفيديو قبل التحميل أو التصدير.
            </p>
          ) : null}
        </section>
      ) : null}

      {source.kind === "local" ? (
        <section className="source-card" aria-label="بيانات الملف المحلي">
          <strong>{source.path}</strong>
          <span>
            {source.metadata.width}×{source.metadata.height} • {formatDuration(source.metadata.duration)}
          </span>
          <span>
            {source.metadata.hasAudio ? "فيديو + صوت" : "فيديو بدون مسار صوت"}
          </span>
        </section>
      ) : null}

      {state.sourceStatus.kind !== "idle" ? (
        <p className={`source-status source-status-${state.sourceStatus.kind}`} aria-live="polite">
          {"message" in state.sourceStatus ? state.sourceStatus.message : ""}
        </p>
      ) : null}
    </div>
  );
}

function formatDuration(durationUs: number): string {
  const seconds = Math.max(0, Math.round(durationUs / 1_000_000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${rest
    .toString()
    .padStart(2, "0")}`;
}
