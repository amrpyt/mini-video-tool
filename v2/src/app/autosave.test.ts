import { afterEach, describe, expect, it, vi } from "vitest";

import { createAutosaveController } from "./autosave";

afterEach(() => {
  vi.useRealTimers();
});

describe("project autosave", () => {
  it("coalesces project edits into one save after 750ms", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const controller = createAutosaveController(save, 750);

    controller.schedule({ schemaVersion: 1, revision: 1 });
    await vi.advanceTimersByTimeAsync(500);
    controller.schedule({ schemaVersion: 1, revision: 2 });
    await vi.advanceTimersByTimeAsync(749);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ schemaVersion: 1, revision: 2 });
    controller.dispose();
  });

  it("does not reschedule when only non-project runtime state changes", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const controller = createAutosaveController(save, 750);
    const project = { schemaVersion: 1, selection: { start: 0, end: 1_000_000 } };

    controller.schedule(project);
    controller.scheduleIfChanged(project);
    controller.scheduleIfChanged(project);
    await vi.advanceTimersByTimeAsync(750);

    expect(save).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
