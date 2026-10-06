import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialEditorState, editorReducer } from "../../app/editorReducer";
import { ExportStep } from "./ExportStep";

afterEach(cleanup);

describe("ExportStep", () => {
  it("summarizes the final render and sends one structured export request", async () => {
    let state = editorReducer(createInitialEditorState(), {
      type: "source/localLoaded",
      path: "C:\\Media Files\\input.mp4",
      metadata: {
        duration: 20_000_000,
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30_000, denominator: 1_001 },
        hasAudio: true,
      },
    });
    state = editorReducer(state, {
      type: "project/setSelection",
      selection: { start: 2_000_000, end: 18_000_000 },
    });
    const exportProject = vi.fn().mockResolvedValue(42);

    render(
      <ExportStep
        project={state.project}
        outputPath={"C:\\Exports\\final.mp4"}
        onChooseOutput={vi.fn()}
        exportProject={exportProject}
      />,
    );

    expect(screen.getByText(/C:\\Media Files\\input\.mp4/)).toBeInTheDocument();
    expect(screen.getByText(/00:00:02\.000/)).toBeInTheDocument();
    expect(screen.getByText(/1920×1080/)).toBeInTheDocument();
    expect(screen.getByText(/تلقائي/)).toBeInTheDocument();
    expect(screen.getByText(/كل التعديلات المختارة.*رندر نهائي واحد/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "تصدير الفيديو النهائي" }));
    expect(exportProject).toHaveBeenCalledTimes(1);
    expect(exportProject).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "C:\\Exports\\final.mp4",
        preferHardware: true,
        input: expect.objectContaining({ path: "C:\\Media Files\\input.mp4", sourceOffset: 0 }),
        project: expect.objectContaining({ schemaVersion: 1 }),
      }),
    );
  });

  it("resolves a partial YouTube source only when final export is requested", async () => {
    let state = createInitialEditorState();
    state = editorReducer(state, {
      type: "source/youtubeLoaded",
      url: "https://youtu.be/example",
      metadata: {
        videoId: "example",
        title: "Example",
        duration: 30_000_000,
        thumbnailUrl: null,
        qualities: ["best", "p720"],
      },
    });
    state = editorReducer(state, {
      type: "project/setSelection",
      selection: { start: 5_000_000, end: 15_000_000 },
    });
    const resolveInput = vi.fn().mockResolvedValue({
      path: "C:\\Cache\\partial.webm",
      sourceOffset: 4_500_000,
      metadata: {
        duration: 10_500_000,
        width: 1280,
        height: 720,
        frameRate: { numerator: 30, denominator: 1 },
        hasAudio: true,
      },
    });
    const exportProject = vi.fn().mockResolvedValue(9);

    render(
      <ExportStep
        project={state.project}
        outputPath="C:\\Exports\\youtube-final.mp4"
        onChooseOutput={vi.fn()}
        resolveInput={resolveInput}
        exportProject={exportProject}
      />,
    );

    expect(resolveInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "تصدير الفيديو النهائي" }));
    await screen.findByText(/بدأت عملية التصدير رقم 9/);
    expect(resolveInput).toHaveBeenCalledTimes(1);
    expect(exportProject).toHaveBeenCalledTimes(1);
    expect(exportProject.mock.calls[0][0].input).toEqual(
      expect.objectContaining({
        path: "C:\\Cache\\partial.webm",
        sourceOffset: 4_500_000,
      }),
    );
  });
});
