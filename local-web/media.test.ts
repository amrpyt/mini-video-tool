import { describe, expect, test } from "bun:test";
import {
  buildKeepSegments,
  formatSelector,
  formatTimestamp,
  parseSilenceDetect,
  parseSrt,
  remapCuesThroughCuts,
} from "./media";

describe("local web media helpers", () => {
  test("formats partial timestamps", () => {
    expect(formatTimestamp(65.25)).toBe("00:01:05.250");
  });

  test("keeps bounded quality selectors", () => {
    expect(formatSelector("p720")).toContain("height<=720");
    expect(formatSelector("best")).toBe("bv*+ba/b");
  });

  test("parses silence, closes trailing silence, and protects speech with 200ms margins", () => {
    const stderr = [
      "silence_start: 1",
      "silence_end: 3 | silence_duration: 2",
      "silence_start: 8",
    ].join("\n");
    expect(parseSilenceDetect(stderr, 10, 20)).toEqual([
      { start: 21.2, end: 22.8 },
      { start: 28.2, end: 29.8 },
    ]);
  });

  test("builds kept segments after merged removals", () => {
    expect(buildKeepSegments(10, [{ start: 1, end: 2 }, { start: 1.5, end: 3 }, { start: 6, end: 7 }])).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 6 },
      { start: 7, end: 10 },
    ]);
  });

  test("parses SRT and remaps captions around removed silence", () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:05,000\nHello\n");
    expect(cues).toEqual([{ start: 1, end: 5, text: "Hello" }]);
    expect(remapCuesThroughCuts(cues, 6, [{ start: 2, end: 3 }])).toEqual([
      { start: 1, end: 2, text: "Hello" },
      { start: 2, end: 4, text: "Hello" },
    ]);
  });
});
