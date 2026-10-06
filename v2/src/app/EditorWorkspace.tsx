import { convertFileSrc } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useReducer, useRef, useState } from "react";

import { Inspector } from "../components/Inspector";
import { Preview } from "../components/Preview";
import { Stepper, STEP_LABELS } from "../components/Stepper";
import { Timeline, type FilmstripFrame } from "../components/timeline/Timeline";
import { RangeStep } from "../features/range/RangeStep";
import { CaptionsStep } from "../features/captions/CaptionsStep";
import { DesignStep } from "../features/design/DesignStep";
import { ExportStep } from "../features/export/ExportStep";
import { formatTimeInput, frameStepUs } from "../features/range/timeInput";
import { SilenceStep } from "../features/silence/SilenceStep";
import { SourceStep } from "../features/source/SourceStep";
import {
  analyzeSilence,
  downloadRange,
  extractFilmstrip,
  getYouTubeCaptions,
  importCaptions,
} from "../lib/backend";
import type {
  CaptionTrack,
  ResolvedDownload,
  ResolvedExportInput,
  SilenceAnalysis,
  SourceMetadata,
  TimeRange,
} from "../lib/types";
import {
  EDITOR_STEPS,
  createInitialEditorState,
  editorReducer,
  projectFrameRate,
  requiresNarrowerYouTubeRange,
  sourceDurationUs,
  type EditorAction,
  type EditorState,
  type EditorStep,
} from "./editorReducer";

export function EditorWorkspace() {
  const [state, dispatch] = useReducer(editorReducer, undefined, createInitialEditorState);
  const [waveform, setWaveform] = useState<{ url: string; range: TimeRange } | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [exportPath, setExportPath] = useState("");
  const [resolvedYouTube, setResolvedYouTube] = useState<{
    identity: string;
    value: ResolvedDownload;
  } | null>(null);

  useEditorShortcuts(state, dispatch);

  const selection = state.project.selection;
  const durationUs = sourceDurationUs(state.project);
  const localSource = state.project.source.kind === "local" ? state.project.source : null;
  const youtubeDownloadIdentity =
    state.project.source.kind === "youtube" && selection
      ? `${state.project.source.url}|${selection.start}|${selection.end}|${state.project.source.downloadQuality}`
      : "youtube-download-unavailable";
  const youtubeDownloadIdentityRef = useRef(youtubeDownloadIdentity);
  youtubeDownloadIdentityRef.current = youtubeDownloadIdentity;
  const activeYouTubeDownload =
    resolvedYouTube?.identity === youtubeDownloadIdentity ? resolvedYouTube.value : null;
  const filmstripFrames = useLocalFilmstrip(state.project.source, activeYouTubeDownload);
  const analysisMedia = localSource
    ? {
        path: localSource.path,
        metadata: localSource.metadata,
        sourceOffset: 0,
      }
    : activeYouTubeDownload
      ? {
          path: activeYouTubeDownload.path,
          metadata: activeYouTubeDownload.metadata,
          sourceOffset: activeYouTubeDownload.sourceOffset,
        }
      : null;
  const silenceAnalysisIdentity =
    analysisMedia && selection
      ? `${analysisMedia.path}|${analysisMedia.sourceOffset}|${selection.start}|${selection.end}`
      : "silence-unavailable";
  const silenceAnalysisIdentityRef = useRef(silenceAnalysisIdentity);
  silenceAnalysisIdentityRef.current = silenceAnalysisIdentity;

  useEffect(() => {
    setWaveform(null);
  }, [silenceAnalysisIdentity]);

  const sourceIdentity =
    state.project.source.kind === "local"
      ? `local:${state.project.source.path}`
      : state.project.source.kind === "youtube"
        ? `youtube:${state.project.source.url}`
        : "none";

  useEffect(() => {
    setSelectedOverlayId(null);
    setExportPath("");
    setResolvedYouTube(null);
  }, [sourceIdentity]);

  async function runSilenceAnalysis(): Promise<SilenceAnalysis | null> {
    if (!analysisMedia || !selection) {
      throw new Error("تحليل الصمت يحتاج ملفًا محليًا وتحديدًا صالحًا.");
    }
    const requestIdentity = silenceAnalysisIdentity;
    const cacheRoot = await appCacheDir();
    const waveformDestination = await join(
      cacheRoot,
      "mini-video-tool-v2",
      "waveform",
      `wave-${selection.start}-${selection.end}.png`,
    );
    const result = await analyzeSilence({
      source: analysisMedia.path,
      selection,
      sourceOffset: analysisMedia.sourceOffset,
      localDuration: analysisMedia.metadata.duration,
      hasAudio: analysisMedia.metadata.hasAudio,
      waveformDestination,
    });
    return silenceAnalysisIdentityRef.current === requestIdentity ? result : null;
  }

  async function resolveExportInput(): Promise<ResolvedExportInput | null> {
    if (state.project.source.kind === "local") {
      return {
        path: state.project.source.path,
        sourceOffset: 0,
        metadata: state.project.source.metadata,
      };
    }
    if (
      state.project.source.kind !== "youtube" ||
      !selection ||
      requiresNarrowerYouTubeRange(state.project)
    ) {
      return null;
    }
    if (activeYouTubeDownload) {
      return {
        path: activeYouTubeDownload.path,
        sourceOffset: activeYouTubeDownload.sourceOffset,
        metadata: activeYouTubeDownload.metadata,
      };
    }

    const requestIdentity = youtubeDownloadIdentity;
    const cacheRoot = await appCacheDir();
    const outputDir = await join(cacheRoot, "mini-video-tool-v2", "downloads");
    const value = await downloadRange({
      url: state.project.source.url,
      selection,
      sourceDuration: state.project.source.metadata.duration,
      quality: state.project.source.downloadQuality,
      outputDir,
    });
    if (youtubeDownloadIdentityRef.current !== requestIdentity) {
      return null;
    }
    setResolvedYouTube({ identity: requestIdentity, value });
    return {
      path: value.path,
      sourceOffset: value.sourceOffset,
      metadata: value.metadata,
    };
  }

  const previewCanUseResolved =
    state.project.source.kind === "youtube" &&
    activeYouTubeDownload !== null &&
    state.playheadUs >= activeYouTubeDownload.sourceOffset &&
    state.playheadUs <= activeYouTubeDownload.sourceOffset + activeYouTubeDownload.metadata.duration;
  const previewSource = previewCanUseResolved && activeYouTubeDownload
    ? {
        kind: "local" as const,
        path: activeYouTubeDownload.path,
        metadata: activeYouTubeDownload.metadata,
        downloadQuality: state.project.source.downloadQuality,
      }
    : state.project.source;
  const previewMediaPlayheadUs =
    previewCanUseResolved && activeYouTubeDownload
      ? state.playheadUs - activeYouTubeDownload.sourceOffset
      : state.playheadUs;

  return (
    <div className="app-shell" dir="rtl">
      <header className="app-header">
        <div>
          <p className="eyebrow">محرر فيديو محلي</p>
          <h1>Mini Video Tool</h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={state.history.length === 0}
            onClick={() => dispatch({ type: "history/undo" })}
          >
            تراجع
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={state.future.length === 0}
            onClick={() => dispatch({ type: "history/redo" })}
          >
            إعادة
          </button>
          <span className="local-badge">محلي</span>
        </div>
      </header>

      <Stepper
        activeStep={state.activeStep}
        onSelect={(step) => dispatch({ type: "navigation/goTo", step })}
      />

      <main className="workspace">
        <section className="panel preview-panel" aria-label="المعاينة" data-testid="persistent-preview">
          <div className="panel-heading">
            <span>المعاينة</span>
            <span className="panel-meta">
              {state.project.source.kind === "local"
                ? `${state.project.source.metadata.width}×${state.project.source.metadata.height}`
                : "معاينة مباشرة"}
            </span>
          </div>
          <div className="preview-stage">
            <Preview
              source={previewSource}
              playheadUs={state.playheadUs}
              mediaPlayheadUs={previewMediaPlayheadUs}
              overlays={state.project.overlays}
              captionTrack={state.project.captions}
              selectedOverlayId={selectedOverlayId}
              onSelectOverlay={setSelectedOverlayId}
              onOverlayGeometryChange={(id, geometry) =>
                dispatch({ type: "overlay/updateGeometry", id, geometry })
              }
            />
          </div>
        </section>

        <Inspector
          title={`إعدادات ${STEP_LABELS[state.activeStep]}`}
          footer={<NavigationFooter state={state} dispatch={dispatch} />}
        >
          {inspectorContent(state, dispatch, {
            runAnalysis: runSilenceAnalysis,
            analysisIdentity: silenceAnalysisIdentity,
            analysisSourcePath: analysisMedia?.path ?? null,
            analysisMetadata: analysisMedia?.metadata ?? null,
            onWaveform: (path) => {
              if (!path || !selection) {
                setWaveform(null);
                return;
              }
              setWaveform({ url: convertFileSrc(path), range: { ...selection } });
            },
            selectedOverlayId,
            onSelectOverlay: setSelectedOverlayId,
            chooseImage: chooseImageFile,
            importCaptions: importCaptionFile,
            loadYouTubeCaptions: async () => {
              if (state.project.source.kind !== "youtube") return null;
              return getYouTubeCaptions(state.project.source.url);
            },
            chooseFont: chooseFontFile,
            exportPath,
            resolvedExportInput:
              state.project.source.kind === "local"
                ? {
                    path: state.project.source.path,
                    sourceOffset: 0,
                    metadata: state.project.source.metadata,
                  }
                : activeYouTubeDownload
                  ? {
                      path: activeYouTubeDownload.path,
                      sourceOffset: activeYouTubeDownload.sourceOffset,
                      metadata: activeYouTubeDownload.metadata,
                    }
                  : null,
            resolveExportInput,
            chooseExportOutput: async () => {
              const selected = await chooseExportFile();
              if (selected) setExportPath(selected);
              return selected;
            },
          })}
        </Inspector>
      </main>

      <section className="panel timeline-panel" aria-label="الخط الزمني" data-testid="persistent-timeline">
        <div className="panel-heading">
          <span>الخط الزمني</span>
          <span className="panel-meta" data-testid="selection-summary" dir="ltr">
            {selection
              ? `${formatTimeInput(selection.start)} — ${formatTimeInput(selection.end)}`
              : "—"}
          </span>
        </div>
        <Timeline
          durationUs={durationUs}
          selection={selection}
          playheadUs={state.playheadUs}
          filmstripFrames={filmstripFrames}
          waveformUrl={waveform?.url}
          waveformRange={waveform?.range}
          detectedRegions={state.project.silence.detectedRegions}
          acceptedRegions={state.project.silence.acceptedRemovedRegions}
          overlays={state.project.overlays}
          captionCues={state.project.captions.enabled ? state.project.captions.cues : []}
          onPlayheadChange={(valueUs) => dispatch({ type: "playhead/set", valueUs })}
          onSelectionChange={(nextSelection) =>
            dispatch({ type: "project/setSelection", selection: nextSelection })
          }
        />
        <div className="timeline-status">
          <span>{durationUs > 0 ? `مدة المصدر ${formatTimeInput(durationUs)}` : "لم يتم اختيار مصدر"}</span>
          {requiresNarrowerYouTubeRange(state.project) ? (
            <span className="timeline-invalid">تحديد يوتيوب لازم يكون أضيق من المصدر الكامل</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function NavigationFooter({
  state,
  dispatch,
}: {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
}) {
  const index = EDITOR_STEPS.indexOf(state.activeStep);
  const previous = EDITOR_STEPS[index - 1];
  const next = EDITOR_STEPS[index + 1];
  return (
    <div className="navigation-actions">
      <button
        type="button"
        className="ghost-button"
        disabled={!previous}
        onClick={() => previous && dispatch({ type: "navigation/goTo", step: previous })}
      >
        السابق
      </button>
      <button
        type="button"
        className="secondary-button"
        disabled={!next}
        onClick={() => dispatch({ type: "navigation/skip" })}
      >
        تخطي الخطوة
      </button>
      <button
        type="button"
        className="primary-button"
        disabled={!next}
        onClick={() => next && dispatch({ type: "navigation/goTo", step: next })}
      >
        التالي
      </button>
    </div>
  );
}

function inspectorContent(
  state: EditorState,
  dispatch: (action: EditorAction) => void,
  silenceRuntime: {
    runAnalysis: () => Promise<SilenceAnalysis | null>;
    analysisIdentity: string;
    analysisSourcePath: string | null;
    analysisMetadata: SourceMetadata | null;
    onWaveform: (path: string | null) => void;
    selectedOverlayId: string | null;
    onSelectOverlay: (id: string | null) => void;
    chooseImage: () => Promise<string | null>;
    importCaptions: () => Promise<CaptionTrack | null>;
    loadYouTubeCaptions: () => Promise<CaptionTrack | null>;
    chooseFont: () => Promise<string | null>;
    exportPath: string;
    resolvedExportInput: ResolvedExportInput | null;
    resolveExportInput: () => Promise<ResolvedExportInput | null>;
    chooseExportOutput: () => Promise<string | null>;
  },
) {
  switch (state.activeStep) {
    case "Source":
      return <SourceStep state={state} dispatch={dispatch} />;
    case "Range":
      return <RangeStep state={state} dispatch={dispatch} />;
    case "Export":
      return (
        <ExportStep
          project={state.project}
          outputPath={silenceRuntime.exportPath}
          onChooseOutput={silenceRuntime.chooseExportOutput}
          resolvedInput={silenceRuntime.resolvedExportInput}
          resolveInput={silenceRuntime.resolveExportInput}
        />
      );
    case "Silence":
      return (
        <SilenceStep
          analysisIdentity={
            silenceRuntime.analysisIdentity
          }
          sourcePath={silenceRuntime.analysisSourcePath}
          metadata={silenceRuntime.analysisMetadata}
          selection={state.project.selection}
          detectedRegions={state.project.silence.detectedRegions}
          acceptedRegions={state.project.silence.acceptedRemovedRegions}
          dispatch={dispatch}
          runAnalysis={silenceRuntime.runAnalysis}
          onWaveform={silenceRuntime.onWaveform}
        />
      );
    case "Design":
      return (
        <DesignStep
          selection={state.project.selection}
          overlays={state.project.overlays}
          selectedOverlayId={silenceRuntime.selectedOverlayId}
          onSelectOverlay={silenceRuntime.onSelectOverlay}
          dispatch={dispatch}
          chooseImage={silenceRuntime.chooseImage}
          canvasAspectRatio={
            state.project.export.height > 0
              ? state.project.export.width / state.project.export.height
              : 16 / 9
          }
        />
      );
    case "Captions":
      return (
        <CaptionsStep
          track={state.project.captions}
          sourceKind={state.project.source.kind}
          dispatch={dispatch}
          onSeek={(timeUs) => dispatch({ type: "playhead/set", valueUs: timeUs })}
          importCaptions={silenceRuntime.importCaptions}
          loadYouTubeCaptions={silenceRuntime.loadYouTubeCaptions}
          chooseFont={silenceRuntime.chooseFont}
        />
      );
  }
}

async function chooseImageFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
  });
  return typeof selected === "string" ? selected : null;
}

async function importCaptionFile(): Promise<CaptionTrack | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Captions", extensions: ["srt", "ass", "ssa"] }],
  });
  return typeof selected === "string" ? importCaptions(selected) : null;
}

async function chooseFontFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Font", extensions: ["ttf", "otf", "ttc"] }],
  });
  return typeof selected === "string" ? selected : null;
}

async function chooseExportFile(): Promise<string | null> {
  const selected = await save({
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    defaultPath: "final.mp4",
  });
  return typeof selected === "string" ? selected : null;
}

function StepPlaceholder({ title, text, warning = false }: { title: string; text: string; warning?: boolean }) {
  return (
    <div className="step-placeholder">
      <h2>{title}</h2>
      <p className={warning ? "field-warning" : "hint-text"}>{text}</p>
      <p className="hint-text">تقدر تتخطى الخطوة وترجعلها في أي وقت بدون فقد التعديلات.</p>
    </div>
  );
}

function useEditorShortcuts(state: EditorState, dispatch: (action: EditorAction) => void) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "history/redo" : "history/undo" });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        dispatch({ type: "history/redo" });
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const selection = state.project.selection;
      const durationUs = sourceDurationUs(state.project);
      if (!selection || durationUs <= 0) return;

      const key = event.key.toLowerCase();
      if (key === "i" && state.playheadUs < selection.end) {
        event.preventDefault();
        dispatch({ type: "project/setSelection", selection: { start: state.playheadUs, end: selection.end } });
      } else if (key === "o" && state.playheadUs > selection.start) {
        event.preventDefault();
        dispatch({ type: "project/setSelection", selection: { start: selection.start, end: state.playheadUs } });
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const frames = event.key === "ArrowRight" ? 1 : -1;
        const next = frameStepUs(state.playheadUs, frames, projectFrameRate(state.project));
        dispatch({ type: "playhead/set", valueUs: Math.max(0, Math.min(durationUs, next)) });
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dispatch, state]);
}

function useLocalFilmstrip(
  source: EditorState["project"]["source"],
  resolvedYouTube: ResolvedDownload | null,
): FilmstripFrame[] {
  const [frames, setFrames] = useState<FilmstripFrame[]>([]);
  const localPath =
    source.kind === "local" ? source.path : source.kind === "youtube" ? resolvedYouTube?.path ?? null : null;
  const localDuration =
    source.kind === "local"
      ? source.metadata.duration
      : source.kind === "youtube"
        ? resolvedYouTube?.metadata.duration ?? 0
        : 0;
  const sourceOffset =
    source.kind === "youtube" && resolvedYouTube ? resolvedYouTube.sourceOffset : 0;

  useEffect(() => {
    let cancelled = false;
    if (!localPath || localDuration <= 0) {
      setFrames([]);
      return () => {
        cancelled = true;
      };
    }
    const sourcePath = localPath;

    async function loadFilmstrip() {
      try {
        const cacheRoot = await appCacheDir();
        const destinationDir = await join(cacheRoot, "mini-video-tool-v2", "filmstrip");
        const paths = await extractFilmstrip({
          source: sourcePath,
          range: { start: 0, end: localDuration },
          count: 12,
          destinationDir,
        });
        if (!cancelled) {
          const count = paths.length;
          setFrames(
            paths.map((path, index) => ({
              url: convertFileSrc(path),
              timeUs:
                sourceOffset + (count > 0 ? Math.round((index * localDuration) / count) : 0),
            })),
          );
        }
      } catch {
        if (!cancelled) setFrames([]);
      }
    }

    void loadFilmstrip();
    return () => {
      cancelled = true;
    };
  }, [localDuration, localPath, sourceOffset]);

  return frames;
}
