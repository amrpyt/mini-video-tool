import type { FrameRate } from "../../lib/types";

export type TimeInputResult =
  | { ok: true; valueUs: number }
  | { ok: false; error: string };

const MICROSECONDS_PER_SECOND = 1_000_000n;

function decimalSecondsToUs(seconds: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(seconds);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  return whole * MICROSECONDS_PER_SECOND + fraction;
}

export function parseTimeInput(text: string, durationUs: number): TimeInputResult {
  const value = text.trim();
  if (!value) return { ok: false, error: "اكتب وقتًا صالحًا" };
  if (value.startsWith("-")) return { ok: false, error: "الوقت لا يمكن أن يكون سالبًا" };

  const parts = value.split(":");
  let totalUs: bigint | null = null;

  if (parts.length === 1) {
    totalUs = decimalSecondsToUs(parts[0]);
  } else if (parts.length === 2 || parts.length === 3) {
    const secondsText = parts.at(-1) ?? "";
    const secondsUs = decimalSecondsToUs(secondsText);
    const minuteText = parts.at(-2) ?? "";
    if (!/^\d+$/.test(minuteText) || secondsUs === null || secondsUs >= 60n * MICROSECONDS_PER_SECOND) {
      return { ok: false, error: "صيغة الوقت غير صحيحة" };
    }
    const minutes = BigInt(minuteText);
    if (parts.length === 3) {
      const hourText = parts[0];
      if (!/^\d+$/.test(hourText) || minutes >= 60n) {
        return { ok: false, error: "صيغة الوقت غير صحيحة" };
      }
      totalUs = (BigInt(hourText) * 3600n + minutes * 60n) * MICROSECONDS_PER_SECOND + secondsUs;
    } else {
      totalUs = minutes * 60n * MICROSECONDS_PER_SECOND + secondsUs;
    }
  }

  if (totalUs === null) return { ok: false, error: "صيغة الوقت غير صحيحة" };
  const max = BigInt(Math.max(0, Math.trunc(durationUs)));
  if (totalUs > max) return { ok: false, error: "الوقت خارج مدة المصدر" };
  if (totalUs > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "الوقت أكبر من النطاق المدعوم" };
  }
  return { ok: true, valueUs: Number(totalUs) };
}

export function formatTimeInput(valueUs: number): string {
  const totalMs = Math.max(0, Math.round(valueUs / 1_000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const millis = totalMs % 1_000;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
}

function roundDivNearest(numerator: bigint, denominator: bigint): bigint {
  let quotient = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder < 0n) {
    quotient -= 1n;
    remainder += denominator;
  }
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function frameStepUs(timeUs: number, frames: number, rate: FrameRate): number {
  if (!Number.isInteger(timeUs) || !Number.isInteger(frames)) {
    throw new Error("frame stepping requires integer microseconds and frame counts");
  }
  if (!Number.isInteger(rate.numerator) || !Number.isInteger(rate.denominator) || rate.numerator <= 0 || rate.denominator <= 0) {
    throw new Error("frame rate numerator and denominator must be positive integers");
  }
  if (frames === 0) return timeUs;

  const numerator = BigInt(rate.numerator);
  const frameScale = BigInt(rate.denominator) * MICROSECONDS_PER_SECOND;
  const scaledFrames = BigInt(frames) * frameScale;
  let stepped: bigint;

  if (scaledFrames % numerator === 0n) {
    stepped = BigInt(timeUs) + scaledFrames / numerator;
  } else {
    const currentFrame = roundDivNearest(BigInt(timeUs) * numerator, frameScale);
    const targetFrame = currentFrame + BigInt(frames);
    stepped = roundDivNearest(targetFrame * frameScale, numerator);
  }

  const result = Number(stepped);
  if (!Number.isSafeInteger(result)) throw new Error("media time is outside the supported range");
  return result;
}
