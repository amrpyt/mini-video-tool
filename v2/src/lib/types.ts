export type MediaTime = number;

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export interface TimeRange {
  start: MediaTime;
  end: MediaTime;
}

export type DownloadQuality = "best" | "p1080" | "p720" | "p480" | "p360";

export interface SourceMetadata {
  duration: MediaTime;
  width: number;
  height: number;
  frameRate: FrameRate;
  hasAudio: boolean;
}

export interface YouTubeMetadata {
  videoId: string;
  title: string;
  duration: MediaTime;
  thumbnailUrl: string | null;
  qualities: DownloadQuality[];
}

export interface DownloadRangeRequest {
  url: string;
  selection: TimeRange;
  sourceDuration: MediaTime;
  quality: DownloadQuality;
  outputDir: string;
}

export interface ResolvedDownload {
  path: string;
  sourceOffset: MediaTime;
  metadata: SourceMetadata;
}

export interface PreviewFrameRequest {
  source: string;
  timestamp: MediaTime;
  destination: string;
}

export interface FilmstripRequest {
  source: string;
  range: TimeRange;
  count: number;
  destinationDir: string;
}
