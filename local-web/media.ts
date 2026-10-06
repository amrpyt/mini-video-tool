import path from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";

export type Quality = "best" | "p1080" | "p720" | "p480" | "p360";

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  ytDlp: string;
}

export interface YouTubeMetadata {
  id: string;
  title: string;
  duration: number;
  thumbnail: string | null;
  qualities: Quality[];
}

export interface SilenceRegion {
  start: number;
  end: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface LogoOverlay {
  x: number;
  y: number;
  width: number;
  opacity: number;
  start: number;
  end: number;
}

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const QUALITY_HEIGHT: Record<Exclude<Quality, "best">, number> = {
  p1080: 1080,
  p720: 720,
  p480: 480,
  p360: 360,
};

export function formatSelector(quality: Quality): string {
  if (quality === "best") return "bv*+ba/b";
  const height = QUALITY_HEIGHT[quality];
  const filter = `[height<=${height}]`;
  const hlsH264 = `bv${filter}[protocol*=m3u8][vcodec^=avc1]+ba[protocol*=m3u8]/b${filter}[protocol*=m3u8][vcodec^=avc1]`;
  const hlsAny = `bv${filter}[protocol*=m3u8]+ba[protocol*=m3u8]/b${filter}[protocol*=m3u8]`;
  const bounded = `bv*${filter}+ba/b${filter}`;
  return `${hlsH264}/${hlsAny}/${bounded}`;
}

export function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = (safe % 60).toFixed(3).padStart(6, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secs}`;
}

export function parseSilenceDetect(stderr: string, duration: number, sourceOffset = 0): SilenceRegion[] {
  const raw: SilenceRegion[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) pendingStart = Number(start[1]);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && pendingStart !== null) {
      const endValue = Number(end[1]);
      if (Number.isFinite(endValue) && endValue > pendingStart) {
        raw.push({ start: pendingStart, end: endValue });
      }
      pendingStart = null;
    }
  }
  if (pendingStart !== null && pendingStart < duration) {
    raw.push({ start: pendingStart, end: duration });
  }

  const margin = 0.2;
  return raw
    .map((region) => ({
      start: sourceOffset + Math.max(0, region.start + margin),
      end: sourceOffset + Math.min(duration, region.end - margin),
    }))
    .filter((region) => region.end > region.start);
}

export function buildKeepSegments(duration: number, removed: SilenceRegion[]): SilenceRegion[] {
  const normalized = removed
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const merged: SilenceRegion[] = [];
  for (const region of normalized) {
    const last = merged.at(-1);
    if (last && region.start <= last.end) last.end = Math.max(last.end, region.end);
    else merged.push({ ...region });
  }

  const keep: SilenceRegion[] = [];
  let cursor = 0;
  for (const region of merged) {
    if (region.start > cursor) keep.push({ start: cursor, end: region.start });
    cursor = Math.max(cursor, region.end);
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration });
  return keep.filter((r) => r.end - r.start >= 0.01);
}

export function parseSrt(text: string): CaptionCue[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/);
  const cues: CaptionCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startText, endText] = lines[timeIndex].split("-->").map((value) => value.trim().split(/\s+/)[0]);
    const start = parseSrtTime(startText);
    const end = parseSrtTime(endText);
    const cueText = lines.slice(timeIndex + 1).join("\n").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && cueText) {
      cues.push({ start, end, text: cueText });
    }
  }
  return cues;
}

export function remapCuesThroughCuts(cues: CaptionCue[], duration: number, removed: SilenceRegion[]): CaptionCue[] {
  const keep = buildKeepSegments(duration, removed);
  const result: CaptionCue[] = [];
  let outputCursor = 0;
  for (const segment of keep) {
    const segmentDuration = segment.end - segment.start;
    for (const cue of cues) {
      const start = Math.max(cue.start, segment.start);
      const end = Math.min(cue.end, segment.end);
      if (end <= start) continue;
      result.push({
        start: outputCursor + (start - segment.start),
        end: outputCursor + (end - segment.start),
        text: cue.text,
      });
    }
    outputCursor += segmentDuration;
  }
  return result;
}

export function remapRangeThroughCuts(range: SilenceRegion, duration: number, removed: SilenceRegion[]): SilenceRegion[] {
  const keep = buildKeepSegments(duration, removed);
  const result: SilenceRegion[] = [];
  let outputCursor = 0;
  for (const segment of keep) {
    const start = Math.max(range.start, segment.start);
    const end = Math.min(range.end, segment.end);
    if (end > start) {
      result.push({
        start: outputCursor + (start - segment.start),
        end: outputCursor + (end - segment.start),
      });
    }
    outputCursor += segment.end - segment.start;
  }
  return result;
}

export async function runProcess(command: string, args: string[], timeoutMs = 15 * 60_000): Promise<RunResult> {
  const child = Bun.spawn([command, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const code = await child.exited;
  clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (timedOut) throw new Error(`انتهت مهلة تشغيل ${path.basename(command)}`);
  return { code, stdout, stderr };
}

async function where(name: string): Promise<string | null> {
  const result = await runProcess("where.exe", [name], 5_000).catch(() => null);
  if (!result || result.code !== 0) return null;
  return result.stdout.split(/\r?\n/).map((v) => v.trim()).find(Boolean) ?? null;
}

async function firstExisting(paths: Array<string | undefined>): Promise<string | null> {
  for (const value of paths) {
    if (!value) continue;
    if (await Bun.file(value).exists()) return value;
  }
  return null;
}

export async function resolveTools(repoRoot: string): Promise<ToolPaths> {
  const localApp = process.env.LOCALAPPDATA;
  const staged = path.join(repoRoot, "v2", "src-tauri", "binaries");
  const ffmpeg = await firstExisting([
    process.env.FFMPEG_PATH,
    await where("ffmpeg.exe"),
    localApp ? path.join(localApp, "Mini Video Tool", "ffmpeg.exe") : undefined,
    path.join(staged, "ffmpeg-x86_64-pc-windows-msvc.exe"),
  ]);
  const ffprobe = await firstExisting([
    process.env.FFPROBE_PATH,
    await where("ffprobe.exe"),
    localApp ? path.join(localApp, "Mini Video Tool", "ffprobe.exe") : undefined,
    path.join(staged, "ffprobe-x86_64-pc-windows-msvc.exe"),
  ]);
  const ytDlp = await firstExisting([
    process.env.YTDLP_PATH,
    await where("yt-dlp.exe"),
    localApp ? path.join(localApp, "Mini Video Tool", "yt-dlp.exe") : undefined,
    path.join(staged, "yt-dlp-x86_64-pc-windows-msvc.exe"),
  ]);
  if (!ffmpeg || !ffprobe || !ytDlp) {
    throw new Error("FFmpeg / FFprobe / yt-dlp غير متاحين على الجهاز.");
  }
  return { ffmpeg, ffprobe, ytDlp };
}

export function validateYouTubeUrl(raw: string): string {
  const url = new URL(raw.trim());
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!(host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be")) {
    throw new Error("الرابط لازم يكون رابط يوتيوب.");
  }
  return url.toString();
}

export async function readYouTubeMetadata(tools: ToolPaths, rawUrl: string): Promise<YouTubeMetadata> {
  const url = validateYouTubeUrl(rawUrl);
  const result = await runProcess(tools.ytDlp, ["--no-playlist", "--skip-download", "-J", url], 60_000);
  if (result.code !== 0) throw new Error(lastDiagnostic(result.stderr, "تعذر قراءة بيانات يوتيوب."));
  const json = JSON.parse(result.stdout);
  const duration = Number(json.duration);
  if (!json.id || !json.title || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("بيانات الفيديو من يوتيوب غير مكتملة.");
  }
  const qualities: Quality[] = ["best"];
  const formats = Array.isArray(json.formats) ? json.formats : [];
  for (const [quality, height] of [["p1080", 1080], ["p720", 720], ["p480", 480], ["p360", 360]] as const) {
    if (formats.some((item: any) => Number(item?.height) === height)) qualities.push(quality);
  }
  return {
    id: String(json.id),
    title: String(json.title),
    duration,
    thumbnail: typeof json.thumbnail === "string" ? json.thumbnail : null,
    qualities,
  };
}

export async function readYouTubeCaptions(tools: ToolPaths, rawUrl: string, outputDir: string): Promise<CaptionCue[]> {
  const url = validateYouTubeUrl(rawUrl);
  await mkdir(outputDir, { recursive: true });
  const template = path.join(outputDir, "captions.%(language)s.%(ext)s");
  const result = await runProcess(tools.ytDlp, [
    "--ffmpeg-location", path.dirname(tools.ffmpeg),
    "--no-playlist",
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs", "ar.*,ar",
    "--sub-format", "srt",
    "--convert-subs", "srt",
    "-o", template,
    url,
  ], 2 * 60_000);
  if (result.code !== 0) throw new Error(lastDiagnostic(result.stderr, "تعذر تحميل كابشن يوتيوب."));
  const files = (await readdir(outputDir)).filter((name) => name.startsWith("captions.") && name.toLowerCase().endsWith(".srt"));
  if (files.length === 0) throw new Error("لا يوجد كابشن عربي متاح لهذا الفيديو.");
  const preferred = files.sort((a, b) => captionLanguageRank(a) - captionLanguageRank(b))[0];
  const text = await Bun.file(path.join(outputDir, preferred)).text();
  const cues = parseSrt(text);
  if (cues.length === 0) throw new Error("ملف الكابشن من يوتيوب فارغ أو غير صالح.");
  return cues;
}

export async function downloadRange(
  tools: ToolPaths,
  url: string,
  start: number,
  end: number,
  quality: Quality,
  outputDir: string,
): Promise<string> {
  if (!(start >= 0 && end > start)) throw new Error("التحديد غير صالح.");
  await mkdir(outputDir, { recursive: true });
  const template = path.join(outputDir, "clip.%(ext)s");
  const section = `*${formatTimestamp(start)}-${formatTimestamp(end)}`;
  const args = [
    "--ffmpeg-location", path.dirname(tools.ffmpeg),
    "--no-playlist",
    "--download-sections", section,
    "--force-keyframes-at-cuts",
    "--print", "after_move:FINAL_FILE:%(filepath)s",
    "-f", formatSelector(quality),
    "--no-overwrites",
    "-o", template,
    validateYouTubeUrl(url),
  ];
  const result = await runProcess(tools.ytDlp, args, 20 * 60_000);
  if (result.code !== 0) throw new Error(lastDiagnostic(result.stderr, "تعذر تحميل الجزء المحدد."));
  const printed = result.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("FINAL_FILE:"));
  if (printed) {
    const file = printed.slice("FINAL_FILE:".length).trim();
    if (await Bun.file(file).exists()) return file;
  }
  const files = await readdir(outputDir);
  const fallback = files.find((name) => /^clip\./i.test(name) && !name.endsWith(".part"));
  if (!fallback) throw new Error("تم التحميل لكن لم يتم العثور على ملف الجزء.");
  return path.join(outputDir, fallback);
}

export async function probeMedia(tools: ToolPaths, file: string): Promise<ProbeResult> {
  const result = await runProcess(tools.ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    file,
  ], 30_000);
  if (result.code !== 0) throw new Error(lastDiagnostic(result.stderr, "تعذر فحص الفيديو."));
  const json = JSON.parse(result.stdout);
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((item: any) => item.codec_type === "video");
  const duration = Number(json?.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error("ملف الفيديو الناتج غير صالح.");
  return {
    duration,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    hasAudio: streams.some((item: any) => item.codec_type === "audio"),
  };
}

export async function analyzeSilence(
  tools: ToolPaths,
  file: string,
  localStart: number,
  analysisDuration: number,
  waveformPath: string,
  sourceStart: number,
): Promise<{ regions: SilenceRegion[]; waveformPath: string | null }> {
  const graph = "[0:a]asetpts=PTS-STARTPTS,asplit=2[detectin][wavein];[detectin]silencedetect=noise=-35dB:d=0.6[detected];[wavein]showwavespic=s=1200x160:colors=0x111827[wave]";
  const result = await runProcess(tools.ffmpeg, [
    "-y", "-hide_banner", "-nostats",
    "-ss", localStart.toFixed(6),
    "-t", analysisDuration.toFixed(6),
    "-i", file,
    "-filter_complex", graph,
    "-map", "[detected]", "-f", "null", "-",
    "-map", "[wave]", "-frames:v", "1", "-update", "1", waveformPath,
  ], 5 * 60_000);
  if (result.code !== 0) throw new Error(lastDiagnostic(result.stderr, "تعذر تحليل الصمت."));
  return {
    regions: parseSilenceDetect(result.stderr, analysisDuration, sourceStart),
    waveformPath: await Bun.file(waveformPath).exists() ? waveformPath : null,
  };
}

export async function exportWithoutSilence(
  tools: ToolPaths,
  source: string,
  selectionLocalStart: number,
  selectionDuration: number,
  removedSelectionLocal: SilenceRegion[],
  output: string,
  options: {
    hasAudio?: boolean;
    videoWidth?: number;
    videoHeight?: number;
    logoPath?: string | null;
    logo?: LogoOverlay | null;
    captions?: CaptionCue[];
    captionFontSize?: number;
    captionPosition?: "top" | "middle" | "bottom";
    workDir?: string;
  } = {},
): Promise<void> {
  const hasAudio = options.hasAudio ?? true;
  const keep = buildKeepSegments(selectionDuration, removedSelectionLocal);
  if (keep.length === 0) throw new Error("إزالة الصمت ستحذف الفيديو كله.");
  await mkdir(path.dirname(output), { recursive: true });

  const logo = options.logoPath && options.logo ? normalizeLogo(options.logo, selectionDuration) : null;
  const captions = (options.captions || [])
    .map((cue) => ({
      start: Math.max(0, cue.start),
      end: Math.min(selectionDuration, cue.end),
      text: cue.text,
    }))
    .filter((cue) => cue.end > cue.start && cue.text.trim());
  const hasVisualEffects = Boolean(logo || captions.length > 0);

  if (removedSelectionLocal.length === 0 && !hasVisualEffects) {
    const copy = await runProcess(tools.ffmpeg, [
      "-y", "-hide_banner",
      "-ss", selectionLocalStart.toFixed(6),
      "-t", selectionDuration.toFixed(6),
      "-i", source,
      "-c", "copy",
      output,
    ], 10 * 60_000);
    if (copy.code !== 0) throw new Error(lastDiagnostic(copy.stderr, "تعذر تصدير الفيديو."));
    return;
  }

  const filters: string[] = [];
  const concatInputs: string[] = [];
  keep.forEach((segment, index) => {
    const start = selectionLocalStart + segment.start;
    const end = selectionLocalStart + segment.end;
    filters.push(`[0:v]trim=start=${start.toFixed(6)}:end=${end.toFixed(6)},setpts=PTS-STARTPTS[v${index}]`);
    concatInputs.push(`[v${index}]`);
    if (hasAudio) {
      filters.push(`[0:a]atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)},asetpts=PTS-STARTPTS[a${index}]`);
      concatInputs.push(`[a${index}]`);
    }
  });
  if (hasAudio) filters.push(`${concatInputs.join("")}concat=n=${keep.length}:v=1:a=1[basev][outa]`);
  else filters.push(`${concatInputs.join("")}concat=n=${keep.length}:v=1:a=0[basev]`);

  const args = ["-y", "-hide_banner", "-i", source];
  let videoLabel = "basev";
  if (logo && options.logoPath) {
    args.push("-loop", "1", "-framerate", "1", "-i", options.logoPath);
    const width = Math.max(24, Math.round((options.videoWidth || 1280) * logo.width));
    filters.push(`[1:v]scale=${width}:-1,format=rgba,colorchannelmixer=aa=${logo.opacity.toFixed(3)}[logo]`);
    const outputRanges = remapRangeThroughCuts({ start: logo.start, end: logo.end }, selectionDuration, removedSelectionLocal);
    const enable = outputRanges.length
      ? outputRanges.map((range) => `between(t,${range.start.toFixed(3)},${range.end.toFixed(3)})`).join("+")
      : "0";
    const x = Math.round((options.videoWidth || 1280) * logo.x);
    const y = Math.round((options.videoHeight || 720) * logo.y);
    filters.push(`[${videoLabel}][logo]overlay=x=${x}:y=${y}:enable='${enable}':shortest=1[vlogo]`);
    videoLabel = "vlogo";
  }

  if (captions.length > 0) {
    const remapped = remapCuesThroughCuts(captions, selectionDuration, removedSelectionLocal);
    if (remapped.length > 0) {
      const workDir = options.workDir || path.dirname(output);
      await mkdir(workDir, { recursive: true });
      const subtitlePath = path.join(workDir, `captions-${crypto.randomUUID()}.srt`);
      await writeFile(subtitlePath, cuesToSrt(remapped), "utf8");
      const escaped = escapeFilterPath(subtitlePath);
      const fontSize = Math.max(12, Math.min(96, Math.round(options.captionFontSize || 42)));
      const alignment = options.captionPosition === "top" ? 8 : options.captionPosition === "middle" ? 5 : 2;
      filters.push(`[${videoLabel}]subtitles='${escaped}':force_style='FontSize=${fontSize},Alignment=${alignment},Outline=2,Shadow=1'[vcap]`);
      videoLabel = "vcap";
    }
  }

  if (videoLabel === "basev") filters.push("[basev]null[vout]");
  else filters.push(`[${videoLabel}]null[vout]`);

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "[vout]");
  if (hasAudio) args.push("-map", "[outa]");
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20");
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart", output);
  const result = await runProcess(tools.ffmpeg, args, 30 * 60_000);
  if (result.code !== 0) throw new Error(lastDiagnostic(result.stderr, "تعذر تصدير الفيديو."));
}

function parseSrtTime(value: string): number {
  const match = value.match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0")) / 1000;
}

function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function cuesToSrt(cues: CaptionCue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text.replace(/\r/g, "")}\n`).join("\n");
}

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function normalizeLogo(logo: LogoOverlay, duration: number): LogoOverlay {
  const width = Math.max(0.03, Math.min(0.8, Number(logo.width) || 0.18));
  const x = Math.max(0, Math.min(1 - width, Number(logo.x) || 0));
  const y = Math.max(0, Math.min(0.95, Number(logo.y) || 0));
  const opacityValue = Number(logo.opacity);
  const startValue = Number(logo.start);
  const endValue = Number(logo.end);
  return {
    x,
    y,
    width,
    opacity: Math.max(0, Math.min(1, Number.isFinite(opacityValue) ? opacityValue : 1)),
    start: Math.max(0, Math.min(duration, Number.isFinite(startValue) ? startValue : 0)),
    end: Math.max(0, Math.min(duration, Number.isFinite(endValue) ? endValue : duration)),
  };
}

function captionLanguageRank(name: string): number {
  if (/\.ar\.srt$/i.test(name)) return 0;
  if (/\.ar[-_.]/i.test(name)) return 1;
  return 10;
}

function lastDiagnostic(stderr: string, fallback: string): string {
  const lines = stderr.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  return lines.at(-1) || fallback;
}
