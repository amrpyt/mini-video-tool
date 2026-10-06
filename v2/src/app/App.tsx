const EDITOR_STEPS = [
  { id: "Source", label: "المصدر" },
  { id: "Range", label: "التحديد" },
  { id: "Silence", label: "حذف الصمت" },
  { id: "Design", label: "التصميم" },
  { id: "Captions", label: "الكابشن" },
  { id: "Export", label: "التصدير" },
] as const;

export function App() {
  return (
    <div className="app-shell" dir="rtl">
      <header className="app-header">
        <div>
          <p className="eyebrow">محرر فيديو محلي</p>
          <h1>Mini Video Tool</h1>
        </div>
        <span className="local-badge">محلي</span>
      </header>

      <nav className="stepper" aria-label="خطوات التحرير">
        <ol>
          {EDITOR_STEPS.map((step, index) => (
            <li key={step.id} data-step-id={step.id}>
              <span className="step-index">{index + 1}</span>
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      </nav>

      <main className="workspace">
        <section className="panel preview-panel" aria-label="المعاينة">
          <div className="panel-heading">
            <span>المعاينة</span>
            <span className="panel-meta">16:9</span>
          </div>
          <div className="preview-stage">منطقة المعاينة</div>
        </section>

        <aside className="panel inspector-panel" aria-label="الإعدادات">
          <div className="panel-heading">الإعدادات</div>
          <div className="inspector-placeholder">اختَر خطوة لعرض إعداداتها هنا</div>
        </aside>
      </main>

      <section className="panel timeline-panel" aria-label="الخط الزمني">
        <div className="panel-heading">
          <span>الخط الزمني</span>
          <span className="panel-meta">00:00:00</span>
        </div>
        <div className="timeline-track" aria-hidden="true">
          <span className="timeline-playhead" />
        </div>
      </section>
    </div>
  );
}
