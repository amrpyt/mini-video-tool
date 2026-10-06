import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeJobSnapshot, OperationCockpit } from "./OperationCockpit";

afterEach(cleanup);

describe("OperationCockpit", () => {
  it("ignores stale success after cancellation has started", () => {
    const cancelling = { id: 9, kind: "Export" as const, status: "Cancelling" as const, progress: null };
    expect(
      mergeJobSnapshot(cancelling, {
        id: 9,
        kind: "Export",
        status: "Completed",
        progress: null,
      }),
    ).toEqual(cancelling);
  });

  it("shows progress telemetry and enables stop only for busy jobs", () => {
    const cancel = vi.fn();
    const { rerender } = render(
      <OperationCockpit
        job={{
          id: 7,
          kind: "Export",
          status: "Running",
          progress: {
            stage: "export",
            fraction: 0.42,
            speed: "1.8x",
            etaSeconds: 12,
            message: "Exporting 42%",
          },
        }}
        onCancel={cancel}
      />,
    );

    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("1.8x")).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "إيقاف العملية" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(cancel).toHaveBeenCalledWith(7);

    rerender(
      <OperationCockpit
        job={{ id: 7, kind: "Export", status: "Cancelling", progress: null }}
        onCancel={cancel}
      />,
    );
    expect(screen.getByText("جاري الإلغاء")).toBeInTheDocument();
    expect(stop).toBeDisabled();

    rerender(
      <OperationCockpit
        job={{ id: 7, kind: "Export", status: "Cancelled", progress: null }}
        onCancel={cancel}
      />,
    );
    expect(screen.getByText("ملغاة")).toBeInTheDocument();
    expect(stop).toBeDisabled();

    rerender(
      <OperationCockpit
        job={{ id: 8, kind: "Export", status: "Completed", progress: null }}
        onCancel={cancel}
      />,
    );
    expect(screen.getByText("اكتملت")).toBeInTheDocument();
    expect(stop).toBeDisabled();
  });
});
