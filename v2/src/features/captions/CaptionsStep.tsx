import { useState } from "react";

import type { EditorAction } from "../../app/editorReducer";
import type { CaptionTrack } from "../../lib/types";

interface CaptionsStepProps {
  track: CaptionTrack;
  sourceKind: "none" | "local" | "youtube";
  dispatch: (action: EditorAction) => void;
  onSeek: (timeUs: number) => void;
  importCaptions: () => Promise<CaptionTrack | null>;
  loadYouTubeCaptions: () => Promise<CaptionTrack | null>;
  chooseFont: () => Promise<string | null>;
}

export function CaptionsStep({
  track,
  sourceKind,
  dispatch,
  onSeek,
  importCaptions,
  loadYouTubeCaptions,
  chooseFont,
}: CaptionsStepProps) {
  const [busy, setBusy] = useState<"import" | "youtube" | "font" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(kind: "import" | "youtube") {
    setBusy(kind);
    setError(null);
    try {
      const result = kind === "import" ? await importCaptions() : await loadYouTubeCaptions();
      if (result) dispatch({ type: "captions/setTrack", track: result });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function selectFont() {
    setBusy("font");
    setError(null);
    try {
      const path = await chooseFont();
      if (path) {
        dispatch({ type: "captions/updateStyle", patch: { fontPath: path } });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="inspector-stack">
      <div className="inspector-section">
        <h3>مصدر الكابشن</h3>
        <div className="caption-source-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy !== null}
            onClick={() => void load("import")}
          >
            استيراد SRT / ASS
          </button>
          {sourceKind === "youtube" ? (
            <button
              type="button"
              className="secondary-button"
              disabled={busy !== null}
              onClick={() => void load("youtube")}
            >
              جلب كابشن يوتيوب العربي
            </button>
          ) : null}
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={track.enabled}
            onChange={(event) =>
              dispatch({ type: "captions/setEnabled", enabled: event.currentTarget.checked })
            }
          />
          تفعيل الكابشن
        </label>
        {error ? <p className="field-error">{error}</p> : null}
      </div>

      <div className="inspector-section">
        <h3>الشكل</h3>
        <label className="field-label" htmlFor="caption-size">
          حجم الكابشن
        </label>
        <input
          id="caption-size"
          aria-label="حجم الكابشن"
          type="number"
          min="1"
          max="12"
          step="0.1"
          value={track.style.sizePercent}
          onChange={(event) =>
            dispatch({
              type: "captions/updateStyle",
              patch: { sizePercent: Number(event.currentTarget.value) },
            })
          }
        />
        <label className="field-label" htmlFor="caption-outline-width">
          سمك الحدود
        </label>
        <input
          id="caption-outline-width"
          aria-label="سمك الحدود"
          type="number"
          min="0"
          max="10"
          step="0.1"
          value={track.style.outlineWidth}
          onChange={(event) =>
            dispatch({
              type: "captions/updateStyle",
              patch: { outlineWidth: Number(event.currentTarget.value) },
            })
          }
        />
        <label className="field-label" htmlFor="caption-shadow">
          الظل
        </label>
        <input
          id="caption-shadow"
          aria-label="الظل"
          type="number"
          min="0"
          max="20"
          step="0.1"
          value={track.style.shadow}
          onChange={(event) =>
            dispatch({ type: "captions/updateStyle", patch: { shadow: Number(event.currentTarget.value) } })
          }
        />
        <div className="caption-color-grid">
          <label>
            لون النص
            <input
              type="color"
              value={track.style.textColor}
              onChange={(event) =>
                dispatch({
                  type: "captions/updateStyle",
                  patch: { textColor: event.currentTarget.value },
                })
              }
            />
          </label>
          <label>
            لون الحدود
            <input
              type="color"
              value={track.style.outlineColor}
              onChange={(event) =>
                dispatch({
                  type: "captions/updateStyle",
                  patch: { outlineColor: event.currentTarget.value },
                })
              }
            />
          </label>
          <label>
            لون الظل
            <input
              aria-label="لون الظل"
              type="color"
              value={track.style.shadowColor}
              onChange={(event) =>
                dispatch({ type: "captions/updateStyle", patch: { shadowColor: event.currentTarget.value } })
              }
            />
          </label>
          <label>
            لون الخلفية
            <input
              aria-label="لون الخلفية"
              type="color"
              value={track.style.backgroundColor}
              onChange={(event) =>
                dispatch({ type: "captions/updateStyle", patch: { backgroundColor: event.currentTarget.value } })
              }
            />
          </label>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={track.style.bold}
            onChange={(event) =>
              dispatch({ type: "captions/updateStyle", patch: { bold: event.currentTarget.checked } })
            }
          />
          عريض
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={track.style.italic}
            onChange={(event) =>
              dispatch({ type: "captions/updateStyle", patch: { italic: event.currentTarget.checked } })
            }
          />
          مائل
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={track.style.backgroundEnabled}
            onChange={(event) =>
              dispatch({
                type: "captions/updateStyle",
                patch: { backgroundEnabled: event.currentTarget.checked },
              })
            }
          />
          خلفية سوداء
        </label>
        <label className="field-label" htmlFor="caption-background-opacity">
          شفافية الخلفية
        </label>
        <input
          id="caption-background-opacity"
          aria-label="شفافية الخلفية"
          type="number"
          min="0"
          max="100"
          step="1"
          disabled={!track.style.backgroundEnabled}
          value={track.style.backgroundOpacity}
          onChange={(event) =>
            dispatch({
              type: "captions/updateStyle",
              patch: { backgroundOpacity: Number(event.currentTarget.value) },
            })
          }
        />
        <label className="field-label" htmlFor="caption-vertical-position">
          الموضع الرأسي
        </label>
        <select
          id="caption-vertical-position"
          aria-label="الموضع الرأسي"
          value={track.style.verticalPosition}
          onChange={(event) =>
            dispatch({
              type: "captions/updateStyle",
              patch: {
                verticalPosition: event.currentTarget.value as typeof track.style.verticalPosition,
              },
            })
          }
        >
          <option value="top">أعلى</option>
          <option value="middle">منتصف</option>
          <option value="bottom">أسفل</option>
        </select>
        <label className="field-label" htmlFor="caption-horizontal-position">
          المحاذاة
        </label>
        <select
          id="caption-horizontal-position"
          aria-label="المحاذاة"
          value={track.style.horizontalPosition}
          onChange={(event) =>
            dispatch({
              type: "captions/updateStyle",
              patch: {
                horizontalPosition: event.currentTarget.value as typeof track.style.horizontalPosition,
              },
            })
          }
        >
          <option value="left">يسار</option>
          <option value="center">منتصف</option>
          <option value="right">يمين</option>
        </select>
        <label className="field-label" htmlFor="caption-margin">
          الهامش
        </label>
        <input
          id="caption-margin"
          aria-label="الهامش"
          type="number"
          min="0"
          max="30"
          step="0.5"
          value={track.style.marginPercent}
          onChange={(event) =>
            dispatch({
              type: "captions/updateStyle",
              patch: { marginPercent: Number(event.currentTarget.value) },
            })
          }
        />
        <button
          type="button"
          className="secondary-button"
          disabled={busy !== null}
          onClick={() => void selectFont()}
        >
          اختيار خط محلي
        </button>
        {track.style.fontPath ? (
          <span className="path-preview" dir="ltr">{track.style.fontPath}</span>
        ) : null}
      </div>

      <div className="inspector-section">
        <div className="silence-section-heading">
          <h3>الجمل</h3>
          <span>{track.cues.length}</span>
        </div>
        {track.cues.length === 0 ? (
          <p className="inspector-help">لا توجد جمل كابشن بعد.</p>
        ) : (
          <div className="caption-cue-list">
            {track.cues.map((cue, index) => (
              <button
                key={`${cue.start}-${cue.end}-${index}`}
                type="button"
                className="caption-cue-button"
                onClick={() => onSeek(cue.start)}
              >
                <span dir="ltr">{formatSeconds(cue.start)}</span>
                <span>{cue.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatSeconds(timeUs: number): string {
  return `${(timeUs / 1_000_000).toFixed(3)}s`;
}
