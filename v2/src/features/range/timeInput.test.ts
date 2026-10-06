import { describe, expect, it } from "vitest";

import { frameStepUs, parseTimeInput } from "./timeInput";

describe("parseTimeInput", () => {
  const durationUs = 10_000_000_000;

  it("accepts HH:MM:SS.mmm, MM:SS.mmm, and plain seconds", () => {
    expect(parseTimeInput("01:31:37.250", durationUs)).toEqual({
      ok: true,
      valueUs: 5_497_250_000,
    });
    expect(parseTimeInput("31:37.250", durationUs)).toEqual({
      ok: true,
      valueUs: 1_897_250_000,
    });
    expect(parseTimeInput("12.5", durationUs)).toEqual({
      ok: true,
      valueUs: 12_500_000,
    });
  });

  it("rejects malformed, negative, and out-of-duration values", () => {
    expect(parseTimeInput("-1", durationUs)).toMatchObject({ ok: false });
    expect(parseTimeInput("12:70.000", durationUs)).toMatchObject({ ok: false });
    expect(parseTimeInput("nope", durationUs)).toMatchObject({ ok: false });
    expect(parseTimeInput("10001", durationUs)).toMatchObject({ ok: false });
  });
});

describe("frameStepUs", () => {
  it("uses the same exact rational frame grid as canonical Rust stepping", () => {
    const rate = { numerator: 30_000, denominator: 1_001 };
    let timeUs = 0;

    for (let frame = 0; frame < 30; frame += 1) {
      timeUs = frameStepUs(timeUs, 1, rate);
    }

    expect(timeUs).toBe(1_001_000);

    for (let frame = 0; frame < 30; frame += 1) {
      timeUs = frameStepUs(timeUs, -1, rate);
    }

    expect(timeUs).toBe(0);
  });
});
