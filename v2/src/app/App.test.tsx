import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App shell", () => {
  it("shows the six editor steps without the Python v1 tabs", () => {
    const { container } = render(<App />);

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

    expect(screen.queryByText("تحميل جزء")).not.toBeInTheDocument();
    expect(screen.queryByText("قص الصمت")).not.toBeInTheDocument();
    expect(screen.queryByText("صور + كابشن")).not.toBeInTheDocument();
  });
});
