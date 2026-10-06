import { useState } from "react";

import type { EditorProject } from "../../app/editorReducer";
import { toProjectDocument } from "../../app/projectDocument";
import { formatTimeInput } from "../range/timeInput";
import { exportProject as invokeExportProject } from "../../lib/backend";
import type { ExportProjectRequest, ResolvedExportInput } from "../../lib/types";

interface ExportStepProps {
  project: EditorProject;
  outputPath: string;
  onChooseOutput: () => Promise<string | null>;
  resolvedInput?: ResolvedExportInput | null;
  resolveInput?: () => Promise<ResolvedExportInput | null>;
  exportProject?: (request: ExportProjectRequest) => Promise<number>;
  onRuntimeError?: (error: unknown | null) => void;
}

export function ExportStep({
  project,
  outputPath,
  onChooseOutput,
  resolvedInput,
  resolveInput,
  exportProject = invokeExportProject,
  onRuntimeError,
}: ExportStepProps) {
  const [status, setStatus] = useState<string | null>(null);
  const localInput: ResolvedExportInput | null =
    project.source.kind === "local"
      ? { path: project.source.path, sourceOffset: 0, metadata: project.source.metadata }
      : null;
  const input = resolvedInput ?? localInput;
  const selection = project.selection;
  const canExport = Boolean((input || resolveInput) && selection && outputPath.trim());
  const sourceLabel =
    project.source.kind === "local"
      ? project.source.path
      : project.source.kind === "youtube"
        ? project.source.metadata.title
        : "لم يتم اختيار مصدر";

  async function chooseOutput() {
    await onChooseOutput();
  }

  async function startExport() {
    if (!selection || !outputPath.trim()) return;
    setStatus(input ? "بدء التصدير…" : "تجهيز الجزء المحلي…");
    try {
      const nextInput = input ?? (await resolveInput?.()) ?? null;
      if (!nextInput) {
        throw new Error("تعذر تجهيز مصدر محلي صالح للتصدير.");
      }
      setStatus("بدء التصدير…");
      const jobId = await exportProject(buildExportRequest(project, nextInput, outputPath));
      setStatus(`بدأت عملية التصدير رقم ${jobId}`);
      onRuntimeError?.(null);
    } catch (error) {
      setStatus("تعذر بدء التصدير.");
      onRuntimeError?.(error);
    }
  }

  return (
    <div className="export-step">
      <h2>مراجعة التصدير</h2>
      <div className="export-summary">
        <SummaryRow label="المصدر" value={sourceLabel} ltr />
        <SummaryRow
          label="التحديد"
          value={selection ? `${formatTimeInput(selection.start)} — ${formatTimeInput(selection.end)}` : "—"}
          ltr
        />
        <SummaryRow label="قصّات الصمت" value={String(project.silence.acceptedRemovedRegions.length)} />
        <SummaryRow label="العناصر" value={String(project.overlays.length)} />
        <SummaryRow label="الكابشن" value={project.captions.enabled ? "مفعّل" : "موقوف"} />
        <SummaryRow label="الدقة" value={`${project.export.width}×${project.export.height}`} ltr />
        <SummaryRow label="المرمّز" value="تلقائي" />
        <SummaryRow label="الملف النهائي" value={outputPath || "لم يتم اختياره"} ltr />
      </div>

      <button type="button" className="secondary-button" onClick={chooseOutput}>
        اختيار ملف الإخراج
      </button>

      {project.source.kind === "youtube" && !resolvedInput ? (
        <p className="hint-text">عند التصدير سيتم تنزيل الجزء المحدد فقط، وليس الفيديو كاملًا.</p>
      ) : null}
      <p className="export-one-render-note">كل التعديلات المختارة تُطبّق في رندر نهائي واحد فقط.</p>

      <button
        type="button"
        className="primary-button export-primary-button"
        disabled={!canExport}
        onClick={startExport}
      >
        تصدير الفيديو النهائي
      </button>
      {status ? <p className="hint-text" role="status">{status}</p> : null}
    </div>
  );
}

export function buildExportRequest(
  project: EditorProject,
  input: ResolvedExportInput,
  output: string,
): ExportProjectRequest {
  const canonical = toProjectDocument(
    project,
    project.source.kind === "youtube"
      ? { path: input.path, sourceOffset: input.sourceOffset, metadata: input.metadata }
      : null,
  );
  return { project: canonical, input, output, preferHardware: true };
}

function SummaryRow({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="export-summary-row">
      <span>{label}</span>
      <strong dir={ltr ? "ltr" : undefined}>{value}</strong>
    </div>
  );
}
