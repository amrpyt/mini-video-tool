import { invoke } from "@tauri-apps/api/core";

import type {
  DownloadRangeRequest,
  FilmstripRequest,
  PreviewFrameRequest,
  ResolvedDownload,
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
