import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  analyzeSilence,
  downloadRange,
  exportWithoutSilence,
  probeMedia,
  readYouTubeMetadata,
  resolveTools,
  type Quality,
  type SilenceRegion,
} from "./media";

const repoRoot = path.resolve(import.meta.dir, "..");
const publicDir = path.join(import.meta.dir, "public");
const dataRoot = path.join(process.env.LOCALAPPDATA || repoRoot, "MiniVideoToolWeb");
const cacheRoot = path.join(dataRoot, "cache");
const outputRoot = path.join(process.env.USERPROFILE || repoRoot, "Downloads", "MiniVideoTool");
await mkdir(cacheRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });

const tools = await resolveTools(repoRoot);
const sessions = new Map<string, {
  id: string;
  url: string;
  sourcePath: string;
  waveformPath: string | null;
  sourceOffset: number;
  mediaDuration: number;
  selectionStart: number;
  selectionEnd: number;
  hasAudio: boolean;
  regions: SilenceRegion[];
  outputPath?: string;
}>();

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function fail(error: unknown, status = 400): Response {
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}

function localRequest(req: Request): boolean {
  const host = req.headers.get("host")?.toLowerCase() || "";
  if (!(host.startsWith("127.0.0.1:") || host.startsWith("localhost:"))) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

async function serveLocalFile(req: Request, filePath: string, contentType: string, downloadName?: string): Promise<Response> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  if (downloadName) headers.set("Content-Disposition", `attachment; filename="${downloadName.replace(/\"/g, "")}"`);
  const range = req.headers.get("range");
  if (!range) {
    headers.set("Content-Length", String(file.size));
    return new Response(file, { headers });
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return new Response(null, { status: 416 });
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : file.size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, file.size - suffix);
    end = file.size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= file.size) {
    headers.set("Content-Range", `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  end = Math.min(end, file.size - 1);
  headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(file.slice(start, end + 1), { status: 206, headers });
}

async function body<T>(req: Request): Promise<T> {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new Error("طلب غير صالح.");
  return req.json() as Promise<T>;
}

function safeSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw new Error("جلسة الفيديو انتهت. أعد تحليل الجزء.");
  return session;
}

function safeDownloadName(title = "final"): string {
  const clean = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${clean || "final"}-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`;
}

async function serveStatic(pathname: string): Promise<Response> {
  const target = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^[a-zA-Z0-9._/-]+$/.test(target) || target.includes("..")) return new Response("Not found", { status: 404 });
  const file = Bun.file(path.join(publicDir, target));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.MVT_PORT || 4173),
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (!localRequest(req)) return fail("مرفوض.", 403);
      if (url.pathname === "/api/health") {
        return json({ ok: true, tools, outputRoot });
      }
      if (url.pathname === "/api/metadata" && req.method === "POST") {
        const input = await body<{ url: string }>(req);
        return json(await readYouTubeMetadata(tools, input.url));
      }
      if (url.pathname === "/api/analyze" && req.method === "POST") {
        const input = await body<{ url: string; start: number; end: number; quality?: Quality }>(req);
        const metadata = await readYouTubeMetadata(tools, input.url);
        const start = Number(input.start);
        const end = Number(input.end);
        if (!(start >= 0 && end > start && end <= metadata.duration + 0.5)) throw new Error("التحديد خارج مدة الفيديو.");
        if (start === 0 && Math.abs(end - metadata.duration) < 0.5) throw new Error("حدد جزءًا أصغر من الفيديو أولًا.");
        const id = crypto.randomUUID();
        const sessionDir = path.join(cacheRoot, id);
        await mkdir(sessionDir, { recursive: true });
        const sourcePath = await downloadRange(tools, input.url, start, end, input.quality || "p720", sessionDir);
        const probe = await probeMedia(tools, sourcePath);
        const sourceOffset = Math.max(0, end - probe.duration);
        const localStart = Math.max(0, start - sourceOffset);
        const selectionDuration = end - start;
        if (localStart + selectionDuration > probe.duration + 0.5) {
          throw new Error("الجزء المحمّل لا يغطي التحديد المطلوب بالكامل.");
        }
        const waveformPath = path.join(sessionDir, "waveform.png");
        const analysis = probe.hasAudio
          ? await analyzeSilence(tools, sourcePath, localStart, selectionDuration, waveformPath, start)
          : { regions: [], waveformPath: null };
        sessions.set(id, {
          id,
          url: input.url,
          sourcePath,
          waveformPath: analysis.waveformPath,
          sourceOffset,
          mediaDuration: probe.duration,
          selectionStart: start,
          selectionEnd: end,
          hasAudio: probe.hasAudio,
          regions: analysis.regions,
        });
        return json({
          sessionId: id,
          duration: selectionDuration,
          width: probe.width,
          height: probe.height,
          hasAudio: probe.hasAudio,
          sourceOffset,
          regions: analysis.regions,
          mediaUrl: `/media/${id}`,
          waveformUrl: analysis.waveformPath ? `/waveform/${id}` : null,
        });
      }
      if (url.pathname === "/api/export" && req.method === "POST") {
        const input = await body<{ sessionId: string; removedRegions: SilenceRegion[]; title?: string }>(req);
        const session = safeSession(input.sessionId);
        const selectionDuration = session.selectionEnd - session.selectionStart;
        const selectionLocalStart = session.selectionStart - session.sourceOffset;
        const localRemoved = (input.removedRegions || []).map((region) => ({
          start: Number(region.start) - session.selectionStart,
          end: Number(region.end) - session.selectionStart,
        }));
        const outputPath = path.join(outputRoot, safeDownloadName(input.title));
        await exportWithoutSilence(
          tools,
          session.sourcePath,
          selectionLocalStart,
          selectionDuration,
          localRemoved,
          outputPath,
          session.hasAudio,
        );
        session.outputPath = outputPath;
        return json({ outputPath, downloadUrl: `/output/${session.id}` });
      }
      if (url.pathname === "/api/reveal" && req.method === "POST") {
        const input = await body<{ sessionId: string }>(req);
        const session = safeSession(input.sessionId);
        if (!session.outputPath) throw new Error("صدّر الفيديو أولًا.");
        Bun.spawn(["explorer.exe", `/select,${session.outputPath}`], { stdout: "ignore", stderr: "ignore" });
        return json({ ok: true });
      }
      if (url.pathname.startsWith("/media/") && req.method === "GET") {
        const session = safeSession(url.pathname.split("/").at(-1) || "");
        return serveLocalFile(req, session.sourcePath, "video/mp4");
      }
      if (url.pathname.startsWith("/waveform/") && req.method === "GET") {
        const session = safeSession(url.pathname.split("/").at(-1) || "");
        if (!session.waveformPath) return new Response("Not found", { status: 404 });
        return new Response(Bun.file(session.waveformPath), { headers: { "Content-Type": "image/png" } });
      }
      if (url.pathname.startsWith("/output/") && req.method === "GET") {
        const session = safeSession(url.pathname.split("/").at(-1) || "");
        if (!session.outputPath) return new Response("Not found", { status: 404 });
        return serveLocalFile(req, session.outputPath, "video/mp4", path.basename(session.outputPath));
      }
      if (url.pathname.startsWith("/api/")) return fail("المسار غير موجود.", 404);
      return serveStatic(url.pathname);
    } catch (error) {
      console.error(error);
      return fail(error, 400);
    }
  },
});

const appUrl = `http://${server.hostname}:${server.port}`;
console.log(`Mini Video Tool Local Web: ${appUrl}`);
console.log(`Exports: ${outputRoot}`);
if (process.env.MVT_NO_OPEN !== "1") {
  Bun.spawn(["cmd.exe", "/c", "start", "", appUrl], { stdout: "ignore", stderr: "ignore" });
}
