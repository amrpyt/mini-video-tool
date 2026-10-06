import type { JobSnapshot } from "../lib/types";

interface OperationCockpitProps {
  job: JobSnapshot | null;
  onCancel: (jobId: number) => void | Promise<void>;
}

const STATUS_LABELS: Record<JobSnapshot["status"], string> = {
  Queued: "في الانتظار",
  Running: "جارية",
  Cancelling: "جاري الإلغاء",
  Completed: "اكتملت",
  Failed: "فشلت",
  Cancelled: "ملغاة",
};

const KIND_LABELS: Record<JobSnapshot["kind"], string> = {
  Download: "تنزيل الجزء",
  SilenceAnalysis: "تحليل الصمت",
  Export: "التصدير النهائي",
};

export function OperationCockpit({ job, onCancel }: OperationCockpitProps) {
  if (!job) return null;
  const busy = job.status === "Queued" || job.status === "Running";
  const fraction = job.progress?.fraction;
  return (
    <section className="operation-cockpit" aria-label="العملية الحالية">
      <div className="operation-heading">
        <strong>{KIND_LABELS[job.kind]}</strong>
        <span>{STATUS_LABELS[job.status]}</span>
      </div>
      {fraction !== null && fraction !== undefined ? (
        <div className="operation-progress-row">
          <progress max={1} value={Math.max(0, Math.min(1, fraction))} />
          <span>{Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%</span>
        </div>
      ) : null}
      {job.progress?.message ? <p className="hint-text">{job.progress.message}</p> : null}
      <div className="operation-telemetry">
        {job.progress?.speed ? <span>{job.progress.speed}</span> : null}
        {job.progress?.etaSeconds !== null && job.progress?.etaSeconds !== undefined ? (
          <span>متبقي تقريبًا {job.progress.etaSeconds} ث</span>
        ) : null}
      </div>
      <button
        type="button"
        className="danger-button"
        disabled={!busy}
        onClick={() => void onCancel(job.id)}
      >
        إيقاف العملية
      </button>
    </section>
  );
}

export function mergeJobSnapshot(
  current: JobSnapshot | null,
  incoming: JobSnapshot | null,
): JobSnapshot | null {
  if (!incoming) return current;
  if (!current || incoming.id > current.id) return incoming;
  if (incoming.id < current.id) return current;
  if (current.status === "Cancelled") return current;
  if (
    current.status === "Cancelling" &&
    (incoming.status === "Queued" || incoming.status === "Running" || incoming.status === "Completed")
  ) {
    return current;
  }
  return incoming;
}
