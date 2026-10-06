import { invoke } from "@tauri-apps/api/core";

import type {
  AnalyzeSilenceRequest,
  CaptionTrack,
  DownloadRangeRequest,
  ExportProjectRequest,
  FilmstripRequest,
  JobSnapshot,
  ProjectLoadResult,
  CanonicalExportProject,
  PreviewFrameRequest,
  ResolvedDownload,
  SilenceAnalysis,
  SourceMetadata,
  YouTubeMetadata,
} from "./types";

export function probeSource(path: string): Promise<SourceMetadata> {
  return invoke("probe_source", { path });
}

export function getYouTubeMetadata(url: string): Promise<YouTubeMetadata> {
  return invoke("youtube_metadata", { url });
}

export function downloadRange(request: DownloadRangeRequest): Promise<ResolvedDownload> {
  return invoke("download_range", { request });
}

export function extractPreviewFrame(request: PreviewFrameRequest): Promise<string> {
  return invoke("extract_preview_frame", { request });
}

export function extractFilmstrip(request: FilmstripRequest): Promise<string[]> {
  return invoke("extract_filmstrip", { request });
}

export function analyzeSilence(request: AnalyzeSilenceRequest): Promise<SilenceAnalysis> {
  return invoke("analyze_silence", { request });
}

export function importCaptions(path: string): Promise<CaptionTrack> {
  return invoke("import_captions", { path });
}

export function getYouTubeCaptions(url: string): Promise<CaptionTrack> {
  return invoke("youtube_captions", { url });
}

export function exportProject(request: ExportProjectRequest): Promise<number> {
  return invoke("export_project", { request });
}

export function saveProject(path: string, project: CanonicalExportProject): Promise<void> {
  return invoke("save_project", { path, project });
}

export function loadProject(path: string): Promise<ProjectLoadResult> {
  return invoke("load_project", { path });
}

export function loadProjectIfExists(path: string): Promise<ProjectLoadResult | null> {
  return invoke("load_project_if_exists", { path });
}

export function latestJob(): Promise<JobSnapshot | null> {
  return invoke("latest_job");
}

export function cancelJob(job: number): Promise<JobSnapshot> {
  return invoke("cancel_job", { job });
}
