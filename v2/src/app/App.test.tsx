import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";

afterEach(cleanup);

describe("App shell", () => {
  it("shows the six editor steps without the Python v1 tabs", () => {
    const { container } = render(<App />);

    expect(container.firstElementChild).toHaveAttribute("dir", "rtl");

    for (const label of [
      "المصدر",
      "التحديد",
      "حذف الصمت",
      "التصميم",
      "الكابشن",
      "التصدير",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    expect(
      Array.from(container.querySelectorAll("[data-step-id]"), (element) =>
        element.getAttribute("data-step-id"),
      ),
    ).toEqual(["Source", "Range", "Silence", "Design", "Captions", "Export"]);

    expect(screen.getByRole("region", { name: "المعاينة" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "الإعدادات" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "الخط الزمني" })).toBeInTheDocument();
    for (const name of ["فتح مشروع", "حفظ المشروع", "المصدر", "التالي"]) {
      const button = screen.getByRole("button", { name });
      expect(button.tagName).toBe("BUTTON");
      expect(button).not.toHaveAttribute("tabindex", "-1");
    }

    expect(screen.queryByText("تحميل جزء")).not.toBeInTheDocument();
    expect(screen.queryByText("قص الصمت")).not.toBeInTheDocument();
    expect(screen.queryByText("صور + كابشن")).not.toBeInTheDocument();
  });

  it("keeps preview and timeline mounted while navigation and skip preserve project data", () => {
    render(<App />);

    const preview = screen.getByRole("region", { name: "المعاينة" });
    const timeline = screen.getByRole("region", { name: "الخط الزمني" });
    const selectionBefore = screen.getByTestId("selection-summary").textContent;

    fireEvent.click(screen.getByRole("button", { name: "التحديد" }));
    expect(screen.getByRole("region", { name: "المعاينة" })).toBe(preview);
    expect(screen.getByRole("region", { name: "الخط الزمني" })).toBe(timeline);

    fireEvent.click(screen.getByRole("button", { name: "التصدير" }));
    expect(screen.getByRole("region", { name: "المعاينة" })).toBe(preview);
    expect(screen.getByRole("region", { name: "الخط الزمني" })).toBe(timeline);

    fireEvent.click(screen.getByRole("button", { name: "المصدر" }));
    fireEvent.click(screen.getByRole("button", { name: "تخطي الخطوة" }));

    expect(screen.getByTestId("selection-summary")).toHaveTextContent(selectionBefore ?? "");
    expect(screen.getByRole("region", { name: "المعاينة" })).toBe(preview);
    expect(screen.getByRole("region", { name: "الخط الزمني" })).toBe(timeline);
  });
});
