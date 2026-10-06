import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { editorReducer, createInitialEditorState, type EditorAction } from "../../app/editorReducer";
import type { SourceMetadata, TimeRange } from "../../lib/types";
import { SilenceStep } from "./SilenceStep";

afterEach(cleanup);

const metadata: SourceMetadata = {
  duration: 10_000_000,
  width: 1920,
  height: 1080,
  frameRate: { numerator: 30_000, denominator: 1_001 },
  hasAudio: true,
};

const detected: TimeRange[] = [
  { start: 1_000_000, end: 2_000_000 },
  { start: 4_000_000, end: 5_000_000 },
];

describe("SilenceStep", () => {
  it("keeps detected and accepted regions separate and edits only project state", () => {
    let state = editorReducer(createInitialEditorState(), {
      type: "source/localLoaded",
      path: "C:\\Video\\clip.mp4",
      metadata,
    });
    state = editorReducer(state, { type: "silence/setAnalysis", detectedRegions: detected });
    expect(state.project.silence.detectedRegions).toEqual(detected);
    expect(state.project.silence.acceptedRemovedRegions).toEqual(detected);
    expect(state.project.silence.detectedRegions).not.toBe(state.project.silence.acceptedRemovedRegions);

    state = editorReducer(state, { type: "silence/toggleAccepted", region: detected[0] });
    expect(state.project.silence.detectedRegions).toEqual(detected);
    expect(state.project.silence.acceptedRemovedRegions).toEqual([detected[1]]);

    state = editorReducer(state, { type: "silence/splitAccepted", index: 0, atUs: 4_500_000 });
    expect(state.project.silence.acceptedRemovedRegions).toEqual([
      { start: 4_000_000, end: 4_500_000 },
      { start: 4_500_000, end: 5_000_000 },
    ]);

    state = editorReducer(state, { type: "silence/mergeAccepted", firstIndex: 0, secondIndex: 1 });
    expect(state.project.silence.acceptedRemovedRegions).toEqual([detected[1]]);

    state = editorReducer(state, { type: "silence/setAnalysis", detectedRegions: detected });
    state = editorReducer(state, { type: "silence/splitAccepted", index: 0, atUs: 1_500_000 });
    state = editorReducer(state, { type: "silence/toggleAccepted", region: detected[0] });
    expect(state.project.silence.acceptedRemovedRegions).toEqual([detected[1]]);
    state = editorReducer(state, { type: "silence/toggleAccepted", region: detected[0] });
    expect(state.project.silence.acceptedRemovedRegions).toEqual(detected);

    state = editorReducer(state, { type: "silence/disableRemoval" });
    expect(state.project.silence.detectedRegions).toEqual(detected);
    expect(state.project.silence.acceptedRemovedRegions).toEqual([]);
  });

  it("calls analysis only from the explicit analyze button, never from review edits", async () => {
    const runAnalysis = vi.fn().mockResolvedValue({
      detectedRegions: detected,
      waveformImage: "C:\\cache\\wave.png",
    });
    const actions: EditorAction[] = [];

    render(
      <SilenceStep
        analysisIdentity="C:\\Video\\clip.mp4|0|10000000"
        sourcePath="C:\\Video\\clip.mp4"
        metadata={metadata}
        selection={{ start: 0, end: 10_000_000 }}
        detectedRegions={detected}
        acceptedRegions={detected}
        dispatch={(action) => actions.push(action)}
        runAnalysis={runAnalysis}
        onWaveform={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "الاحتفاظ بهذا الصمت" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "تعطيل حذف الصمت" }));
    expect(runAnalysis).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "تحليل الصمت" }));
    await waitFor(() => expect(runAnalysis).toHaveBeenCalledTimes(1));
    expect(actions.some((action) => action.type === "silence/setAnalysis")).toBe(true);
  });

  it("ignores a completed analysis after source or selection identity changes", async () => {
    let resolveAnalysis!: (value: {
      detectedRegions: TimeRange[];
      waveformImage: string | null;
    }) => void;
    const runAnalysis = vi.fn(
      () =>
        new Promise<{
          detectedRegions: TimeRange[];
          waveformImage: string | null;
        }>((resolve) => {
          resolveAnalysis = resolve;
        }),
    );
    const dispatch = vi.fn();
    const onWaveform = vi.fn();
    const props = {
      sourcePath: "C:\\Video\\clip-a.mp4",
      metadata,
      selection: { start: 0, end: 10_000_000 },
      detectedRegions: [] as TimeRange[],
      acceptedRegions: [] as TimeRange[],
      dispatch,
      runAnalysis,
      onWaveform,
    };

    const { rerender } = render(
      <SilenceStep
        {...props}
        analysisIdentity="C:\\Video\\clip-a.mp4|0|10000000"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "تحليل الصمت" }));
    expect(runAnalysis).toHaveBeenCalledTimes(1);

    rerender(
      <SilenceStep
        {...props}
        sourcePath="C:\\Video\\clip-b.mp4"
        analysisIdentity="C:\\Video\\clip-b.mp4|0|10000000"
      />,
    );
    resolveAnalysis({
      detectedRegions: [{ start: 1_000_000, end: 2_000_000 }],
      waveformImage: "C:\\cache\\stale-wave.png",
    });

    await waitFor(() => expect(runAnalysis).toHaveBeenCalledTimes(1));
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "silence/setAnalysis" }),
    );
    expect(onWaveform).not.toHaveBeenCalled();
  });

  it("ignores a completed analysis after the step unmounts and the parent source identity changes", async () => {
    let resolveBackend!: (value: {
      detectedRegions: TimeRange[];
      waveformImage: string | null;
    }) => void;
    let currentParentIdentity = "C:\\Video\\clip-a.mp4|0|10000000";
    const backendPromise = new Promise<{
      detectedRegions: TimeRange[];
      waveformImage: string | null;
    }>((resolve) => {
      resolveBackend = resolve;
    });
    const runAnalysis = vi.fn(async () => {
      const requestIdentity = currentParentIdentity;
      const result = await backendPromise;
      return currentParentIdentity === requestIdentity ? result : null;
    });
    const dispatch = vi.fn();
    const onWaveform = vi.fn();

    const rendered = render(
      <SilenceStep
        analysisIdentity={currentParentIdentity}
        sourcePath="C:\\Video\\clip-a.mp4"
        metadata={metadata}
        selection={{ start: 0, end: 10_000_000 }}
        detectedRegions={[]}
        acceptedRegions={[]}
        dispatch={dispatch}
        runAnalysis={runAnalysis}
        onWaveform={onWaveform}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "تحليل الصمت" }));
    expect(runAnalysis).toHaveBeenCalledTimes(1);

    rendered.unmount();
    currentParentIdentity = "C:\\Video\\clip-b.mp4|0|10000000";
    resolveBackend({
      detectedRegions: [{ start: 1_000_000, end: 2_000_000 }],
      waveformImage: "C:\\cache\\stale-wave.png",
    });
    await backendPromise;
    await Promise.resolve();

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "silence/setAnalysis" }),
    );
    expect(onWaveform).not.toHaveBeenCalled();
  });
});
