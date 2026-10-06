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

export interface AnalyzeSilenceRequest {
  source: string;
  selection: TimeRange;
  sourceOffset: MediaTime;
  localDuration: MediaTime;
  hasAudio: boolean;
  waveformDestination: string;
}

export interface SilenceAnalysis {
  detectedRegions: TimeRange[];
  waveformImage: string | null;
}

export interface NormalizedGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlayKind = "image" | "blackBar";

export interface EditorOverlay {
  id: string;
  kind: OverlayKind;
  range: TimeRange;
  geometry: NormalizedGeometry;
  opacity: number;
  assetPath: string | null;
  aspectLocked: boolean;
}

export interface CaptionCue {
  start: MediaTime;
  end: MediaTime;
  text: string;
}

export interface CaptionStyle {
  sizePercent: number;
  textColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: number;
  shadowColor: string;
  backgroundEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  verticalPosition: "top" | "middle" | "bottom";
  horizontalPosition: "left" | "center" | "right";
  marginPercent: number;
  bold: boolean;
  italic: boolean;
  fontPath: string | null;
}

export interface CaptionTrack {
  enabled: boolean;
  cues: CaptionCue[];
  style: CaptionStyle;
}

export interface CanonicalProjectSource {
  path: string | null;
  metadata: SourceMetadata | null;
  url?: string | null;
  youtubeMetadata?: YouTubeMetadata | null;
  resolvedPath?: string | null;
  sourceOffset?: MediaTime | null;
  resolvedMetadata?: SourceMetadata | null;
  downloadQuality: DownloadQuality;
}

export interface CanonicalExportProject {
  schemaVersion: 1;
  source: CanonicalProjectSource;
  selection: TimeRange | null;
  silence: {
    detectedRegions: TimeRange[];
    acceptedRemovedRegions: TimeRange[];
  };
  overlays: EditorOverlay[];
  captions: CaptionTrack;
  export: {
    width: number;
    height: number;
    frameRate: FrameRate;
  };
}

export interface ResolvedExportInput {
  path: string;
  sourceOffset: MediaTime;
  metadata: SourceMetadata;
}

export interface ExportProjectRequest {
  project: CanonicalExportProject;
  input: ResolvedExportInput;
  output: string;
  preferHardware: boolean;
}

export type SourceAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; message: string }
  | { kind: "notApplicable" };

export interface ProjectLoadResult {
  project: CanonicalExportProject;
  sourceAvailability: SourceAvailability;
}

export type JobKind = "Download" | "SilenceAnalysis" | "Export";
export type JobStatus = "Queued" | "Running" | "Cancelling" | "Completed" | "Failed" | "Cancelled";

export interface JobProgress {
  stage: string;
  fraction: number | null;
  speed: string | null;
  etaSeconds: number | null;
  message: string;
}

export interface JobSnapshot {
  id: number;
  kind: JobKind;
  status: JobStatus;
  progress: JobProgress | null;
}
