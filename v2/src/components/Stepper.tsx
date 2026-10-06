import { EDITOR_STEPS, type EditorStep } from "../app/editorReducer";

const STEP_LABELS: Record<EditorStep, string> = {
  Source: "المصدر",
  Range: "التحديد",
  Silence: "حذف الصمت",
  Design: "التصميم",
  Captions: "الكابشن",
  Export: "التصدير",
};

interface StepperProps {
  activeStep: EditorStep;
  onSelect: (step: EditorStep) => void;
}

export function Stepper({ activeStep, onSelect }: StepperProps) {
  return (
    <nav className="stepper" aria-label="خطوات التحرير">
      <ol>
        {EDITOR_STEPS.map((step, index) => (
          <li key={step} data-step-id={step} data-active={step === activeStep || undefined}>
            <button
              type="button"
              className="step-button"
              aria-current={step === activeStep ? "step" : undefined}
              onClick={() => onSelect(step)}
            >
              <span className="step-index" aria-hidden="true">
                {index + 1}
              </span>
              <span>{STEP_LABELS[step]}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export { STEP_LABELS };
