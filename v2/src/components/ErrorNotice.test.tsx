import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { describeAppError, ErrorNotice } from "./ErrorNotice";

afterEach(cleanup);

describe("ErrorNotice", () => {
  it("keeps the primary error concise and hides technical details until expanded", () => {
    render(
      <ErrorNotice
        message="تعذر تصدير الفيديو."
        technicalDetails="ffmpeg stderr: qsv init failed at device 0"
      />,
    );

    expect(screen.getByText("تعذر تصدير الفيديو.")).toBeInTheDocument();
    expect(screen.queryByText(/qsv init failed/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "التفاصيل التقنية" }));
    expect(screen.getByText(/qsv init failed/)).toBeInTheDocument();
  });

  it("maps a missing source to a recovery-safe user message", () => {
    expect(describeAppError({ SourceUnavailable: "C:\\missing\\clip.mp4" })).toEqual(
      expect.objectContaining({
        message: "ملف المصدر غير متاح. المشروع والتعديلات ما زالوا محفوظين.",
      }),
    );
  });
});
