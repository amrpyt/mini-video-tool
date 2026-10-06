import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App shell", () => {
  it("shows the six editor steps without the Python v1 tabs", () => {
    render(<App />);

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

    expect(screen.queryByText("تحميل جزء")).not.toBeInTheDocument();
    expect(screen.queryByText("قص الصمت")).not.toBeInTheDocument();
    expect(screen.queryByText("صور + كابشن")).not.toBeInTheDocument();
  });
});
