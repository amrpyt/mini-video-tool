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
