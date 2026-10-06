import { convertFileSrc } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { useEffect, useReducer, useState } from "react";

import { Inspector } from "../components/Inspector";
import { Preview } from "../components/Preview";
import { Stepper, STEP_LABELS } from "../components/Stepper";
import { Timeline, type FilmstripFrame } from "../components/timeline/Timeline";
import { RangeStep } from "../features/range/RangeStep";
import { formatTimeInput, frameStepUs } from "../features/range/timeInput";
import { SourceStep } from "../features/source/SourceStep";
import { extractFilmstrip } from "../lib/backend";
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
  const filmstripFrames = useLocalFilmstrip(state.project.source);

  useEditorShortcuts(state, dispatch);

  const selection = state.project.selection;
  const durationUs = sourceDurationUs(state.project);

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
            <Preview source={state.project.source} playheadUs={state.playheadUs} />
          </div>
        </section>

        <Inspector
          title={`إعدادات ${STEP_LABELS[state.activeStep]}`}
          footer={<NavigationFooter state={state} dispatch={dispatch} />}
        >
          {inspectorContent(state, dispatch)}
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

function inspectorContent(state: EditorState, dispatch: (action: EditorAction) => void) {
  switch (state.activeStep) {
    case "Source":
      return <SourceStep state={state} dispatch={dispatch} />;
    case "Range":
      return <RangeStep state={state} dispatch={dispatch} />;
    case "Export":
      return (
        <StepPlaceholder
          title="مراجعة التصدير"
          text={
            requiresNarrowerYouTubeRange(state.project)
              ? "حدد جزءًا أصغر من فيديو يوتيوب قبل التصدير."
              : "إعدادات التصدير التفصيلية هتتضاف في مرحلة التصدير، والمشروع الحالي محفوظ كما هو."
          }
          warning={requiresNarrowerYouTubeRange(state.project)}
        />
      );
    case "Silence":
      return <StepPlaceholder title="حذف الصمت" text="التحليل غير التدميري هيتضاف في الخطوة المخصصة له." />;
    case "Design":
      return <StepPlaceholder title="التصميم" text="أدوات الصور والأشرطة هتتضاف بدون رندر وسيط." />;
    case "Captions":
      return <StepPlaceholder title="الكابشن" text="استيراد وتحرير الكابشن هيتضاف مع المعاينة الحية." />;
  }
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

function useLocalFilmstrip(source: EditorState["project"]["source"]): FilmstripFrame[] {
  const [frames, setFrames] = useState<FilmstripFrame[]>([]);
  const localPath = source.kind === "local" ? source.path : null;
  const localDuration = source.kind === "local" ? source.metadata.duration : 0;

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
              timeUs: count > 0 ? Math.round((index * localDuration) / count) : 0,
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
  }, [localDuration, localPath]);

  return frames;
}
