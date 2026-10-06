import { useEffect, useState } from "react";

import {
  projectFrameRate,
  requiresNarrowerYouTubeRange,
  sourceDurationUs,
  type EditorAction,
  type EditorState,
} from "../../app/editorReducer";
import { formatTimeInput, frameStepUs, parseTimeInput } from "./timeInput";

interface RangeStepProps {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
}

export function RangeStep({ state, dispatch }: RangeStepProps) {
  const durationUs = sourceDurationUs(state.project);
  const selection = state.project.selection;
  const [startText, setStartText] = useState(formatTimeInput(selection?.start ?? 0));
  const [endText, setEndText] = useState(formatTimeInput(selection?.end ?? durationUs));
  const [startError, setStartError] = useState<string | null>(null);
  const [endError, setEndError] = useState<string | null>(null);

  useEffect(() => {
    setStartText(formatTimeInput(selection?.start ?? 0));
    setEndText(formatTimeInput(selection?.end ?? durationUs));
  }, [selection?.start, selection?.end, durationUs]);

  if (!selection || durationUs <= 0) {
    return <p className="empty-state">اختَر مصدرًا أولًا علشان تحدد البداية والنهاية.</p>;
  }
  const currentSelection = selection;

  function commitStart() {
    const parsed = parseTimeInput(startText, durationUs);
    if (!parsed.ok) {
      setStartError(parsed.error);
      return;
    }
    if (parsed.valueUs >= currentSelection.end) {
      setStartError("البداية لازم تكون قبل النهاية");
      return;
    }
    setStartError(null);
    dispatch({
      type: "project/setSelection",
      selection: { start: parsed.valueUs, end: currentSelection.end },
    });
  }

  function commitEnd() {
    const parsed = parseTimeInput(endText, durationUs);
    if (!parsed.ok) {
      setEndError(parsed.error);
      return;
    }
    if (parsed.valueUs <= currentSelection.start) {
      setEndError("النهاية لازم تكون بعد البداية");
      return;
    }
    setEndError(null);
    dispatch({
      type: "project/setSelection",
      selection: { start: currentSelection.start, end: parsed.valueUs },
    });
  }

  function setStartToPlayhead() {
    if (state.playheadUs >= currentSelection.end) {
      setStartError("حرّك المؤشر قبل نقطة النهاية");
      return;
    }
    setStartError(null);
    dispatch({
      type: "project/setSelection",
      selection: { start: state.playheadUs, end: currentSelection.end },
    });
  }

  function setEndToPlayhead() {
    if (state.playheadUs <= currentSelection.start) {
      setEndError("حرّك المؤشر بعد نقطة البداية");
      return;
    }
    setEndError(null);
    dispatch({
      type: "project/setSelection",
      selection: { start: currentSelection.start, end: state.playheadUs },
    });
  }

  function stepPlayhead(frames: number) {
    const stepped = frameStepUs(state.playheadUs, frames, projectFrameRate(state.project));
    dispatch({ type: "playhead/set", valueUs: Math.max(0, Math.min(durationUs, stepped)) });
  }

  return (
    <div className="step-form range-step">
      <p className="hint-text">اكتب الوقت، استخدم المؤشر، أو اختصارات I و O. الأسهم تحرك إطارًا واحدًا.</p>

      <div className="time-field-group">
        <label htmlFor="range-start">البداية</label>
        <input
          id="range-start"
          className="timestamp-input"
          dir="ltr"
          value={startText}
          aria-invalid={Boolean(startError)}
          onChange={(event) => setStartText(event.target.value)}
          onBlur={commitStart}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitStart();
          }}
        />
        {startError ? <span className="field-error">{startError}</span> : null}
        <button type="button" className="secondary-button" onClick={setStartToPlayhead}>
          اجعل البداية عند المؤشر (I)
        </button>
      </div>

      <div className="time-field-group">
        <label htmlFor="range-end">النهاية</label>
        <input
          id="range-end"
          className="timestamp-input"
          dir="ltr"
          value={endText}
          aria-invalid={Boolean(endError)}
          onChange={(event) => setEndText(event.target.value)}
          onBlur={commitEnd}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitEnd();
          }}
        />
        {endError ? <span className="field-error">{endError}</span> : null}
        <button type="button" className="secondary-button" onClick={setEndToPlayhead}>
          اجعل النهاية عند المؤشر (O)
        </button>
      </div>

      <div className="frame-controls" aria-label="تحريك المؤشر بالإطارات">
        <button type="button" className="secondary-button" onClick={() => stepPlayhead(-1)}>
          إطار سابق
        </button>
        <span dir="ltr">{formatTimeInput(state.playheadUs)}</span>
        <button type="button" className="secondary-button" onClick={() => stepPlayhead(1)}>
          إطار تالٍ
        </button>
      </div>

      {requiresNarrowerYouTubeRange(state.project) ? (
        <p className="field-warning" role="alert">
          تحديد يوتيوب الحالي يغطي الفيديو كله. حرّك البداية أو النهاية علشان يبقى التحميل جزئيًا.
        </p>
      ) : null}
    </div>
  );
}
