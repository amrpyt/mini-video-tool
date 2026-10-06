import { useState } from "react";

interface ErrorNoticeProps {
  message: string;
  technicalDetails?: string | null;
}

export function ErrorNotice({ message, technicalDetails }: ErrorNoticeProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="error-notice" role="alert">
      <strong>{message}</strong>
      {technicalDetails ? (
        <>
          <button
            type="button"
            className="ghost-button error-details-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            التفاصيل التقنية
          </button>
          {expanded ? <pre dir="ltr">{technicalDetails}</pre> : null}
        </>
      ) : null}
    </section>
  );
}

export function describeAppError(error: unknown): ErrorNoticeProps {
  const technicalDetails = technicalText(error);
  const key = errorKey(error, technicalDetails);
  const message =
    key === "SourceUnavailable"
      ? "ملف المصدر غير متاح. المشروع والتعديلات ما زالوا محفوظين."
      : key === "MediaProbeFailed" || key === "UnsupportedMedia"
        ? "تعذر قراءة ملف الوسائط."
        : key === "DownloadFailed"
          ? "تعذر تنزيل الجزء المطلوب."
          : key === "AnalysisFailed"
            ? "تعذر تحليل الصمت."
            : key === "ExportFailed"
              ? "تعذر تصدير الفيديو."
              : key === "Cancelled"
                ? "تم إلغاء العملية."
                : "تعذر إكمال العملية.";
  return { message, technicalDetails };
}

function errorKey(error: unknown, text: string): string | null {
  if (error && typeof error === "object") {
    const keys = Object.keys(error as Record<string, unknown>);
    if (keys.length === 1) return keys[0];
  }
  for (const key of [
    "SourceUnavailable",
    "MediaProbeFailed",
    "UnsupportedMedia",
    "DownloadFailed",
    "AnalysisFailed",
    "ExportFailed",
    "Cancelled",
  ]) {
    if (text.toLowerCase().includes(key.toLowerCase())) return key;
  }
  return null;
}

function technicalText(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}
