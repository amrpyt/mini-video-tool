import type { ReactNode } from "react";

interface InspectorProps {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}

export function Inspector({ title, children, footer }: InspectorProps) {
  return (
    <aside className="panel inspector-panel" aria-label="الإعدادات">
      <div className="panel-heading">
        <span>{title}</span>
        <span className="panel-meta">إعدادات الخطوة</span>
      </div>
      <div className="inspector-content">{children}</div>
      <div className="inspector-footer">{footer}</div>
    </aside>
  );
}
