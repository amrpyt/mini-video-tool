import { useEffect, useRef, useState } from "react";

import { isRangeCovered, type EditorAction } from "../../app/editorReducer";
import type { SilenceAnalysis, SourceMetadata, TimeRange } from "../../lib/types";

interface SilenceStepProps {
  analysisIdentity: string;
  sourcePath: string | null;
  metadata: SourceMetadata | null;
  selection: TimeRange | null;
  detectedRegions: TimeRange[];
  acceptedRegions: TimeRange[];
  dispatch: (action: EditorAction) => void;
  runAnalysis: () => Promise<SilenceAnalysis>;
  onWaveform: (path: string | null) => void;
}

export function SilenceStep({
  analysisIdentity,
  sourcePath,
  metadata,
  selection,
  detectedRegions,
  acceptedRegions,
  dispatch,
  runAnalysis,
  onWaveform,
}: SilenceStepProps) {
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const latestIdentityRef = useRef(analysisIdentity);
  const canAnalyze = Boolean(sourcePath && metadata?.hasAudio && selection);

  useEffect(() => {
    latestIdentityRef.current = analysisIdentity;
    setStatus("idle");
    setError(null);
  }, [analysisIdentity]);

  async function analyze() {
    if (!canAnalyze || status === "running") return;
    const requestIdentity = analysisIdentity;
    setStatus("running");
    setError(null);
    try {
      const result = await runAnalysis();
      if (latestIdentityRef.current !== requestIdentity) {
        return;
      }
      dispatch({ type: "silence/setAnalysis", detectedRegions: result.detectedRegions });
      onWaveform(result.waveformImage);
      setStatus("idle");
    } catch (reason) {
      if (latestIdentityRef.current !== requestIdentity) {
        return;
      }
      setStatus("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="inspector-stack">
      <div className="inspector-section">
        <h3>تحليل الصمت</h3>
        <p className="inspector-help">
          التحليل لا يقص الفيديو. هو يكتشف الصمت ويجهّز موجة صوتية، والقص الفعلي يحصل مرة واحدة وقت التصدير.
        </p>
        {!sourcePath ? (
          <p className="field-error">التحليل يحتاج ملف فيديو محليًا أولًا.</p>
        ) : metadata && !metadata.hasAudio ? (
          <p className="field-warning">المصدر لا يحتوي على مسار صوتي؛ يمكنك متابعة التحرير بدون تحليل صمت.</p>
        ) : null}
        <button
          type="button"
          className="primary-button"
          disabled={!canAnalyze || status === "running"}
          onClick={() => void analyze()}
        >
          {status === "running" ? "جاري التحليل…" : "تحليل الصمت"}
        </button>
        {error ? <p className="field-error">{error}</p> : null}
      </div>

      <div className="inspector-section">
        <div className="silence-section-heading">
          <h3>المناطق المكتشفة</h3>
          <span>{detectedRegions.length}</span>
        </div>
        {detectedRegions.length === 0 ? (
          <p className="inspector-help">لم يتم اكتشاف مناطق بعد.</p>
        ) : (
          <div className="silence-region-list">
            {detectedRegions.map((region) => {
              const accepted = isRangeCovered(region, acceptedRegions);
              return (
                <div className="silence-region-row" key={rangeKey(region)}>
                  <span dir="ltr">{formatRange(region)}</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => dispatch({ type: "silence/toggleAccepted", region })}
                  >
                    {accepted ? "الاحتفاظ بهذا الصمت" : "حذف هذا الصمت"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="inspector-section">
        <div className="silence-section-heading">
          <h3>المناطق المقبولة للحذف</h3>
          <span>{acceptedRegions.length}</span>
        </div>
        {acceptedRegions.map((region, index) => {
          const next = acceptedRegions[index + 1];
          const canMergeNext = Boolean(next && region.end >= next.start);
          return (
            <div className="silence-region-row silence-edit-row" key={`accepted-${rangeKey(region)}-${index}`}>
              <span dir="ltr">{formatRange(region)}</span>
              <div className="silence-row-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() =>
                    dispatch({
                      type: "silence/splitAccepted",
                      index,
                      atUs: Math.round((region.start + region.end) / 2),
                    })
                  }
                >
                  تقسيم
                </button>
                {canMergeNext ? (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      dispatch({
                        type: "silence/mergeAccepted",
                        firstIndex: index,
                        secondIndex: index + 1,
                      })
                    }
                  >
                    دمج مع التالي
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className="secondary-button"
          disabled={acceptedRegions.length === 0}
          onClick={() => dispatch({ type: "silence/disableRemoval" })}
        >
          تعطيل حذف الصمت
        </button>
      </div>
    </div>
  );
}

function rangeKey(range: TimeRange): string {
  return `${range.start}-${range.end}`;
}

function formatRange(range: TimeRange): string {
  return `${formatSeconds(range.start)} → ${formatSeconds(range.end)}`;
}

function formatSeconds(timeUs: number): string {
  return `${(timeUs / 1_000_000).toFixed(3)}s`;
}
