import type {
  CaptionStyle,
  CaptionTrack,
  DownloadQuality,
  EditorOverlay,
  FrameRate,
  NormalizedGeometry,
  SourceMetadata,
  TimeRange,
  YouTubeMetadata,
} from "../lib/types";

export type { CaptionTrack, EditorOverlay } from "../lib/types";

export const EDITOR_STEPS = [
  "Source",
  "Range",
  "Silence",
  "Design",
  "Captions",
  "Export",
] as const;

export type EditorStep = (typeof EDITOR_STEPS)[number];

export type EditorSource =
  | { kind: "none"; downloadQuality: DownloadQuality }
  | {
      kind: "local";
      path: string;
      metadata: SourceMetadata;
      downloadQuality: DownloadQuality;
    }
  | {
      kind: "youtube";
      url: string;
      metadata: YouTubeMetadata;
      downloadQuality: DownloadQuality;
    };

export interface EditorProject {
  schemaVersion: 1;
  source: EditorSource;
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

export type SourceStatus =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "ready"; message?: string }
  | { kind: "error"; message: string };

export interface EditorState {
  project: EditorProject;
  activeStep: EditorStep;
  playheadUs: number;
  sourceStatus: SourceStatus;
  history: EditorProject[];
  future: EditorProject[];
}

export type EditorAction =
  | { type: "source/localLoaded"; path: string; metadata: SourceMetadata }
  | { type: "source/youtubeLoaded"; url: string; metadata: YouTubeMetadata }
  | { type: "source/setStatus"; status: SourceStatus }
  | { type: "project/load"; project: EditorProject; sourceStatus?: SourceStatus }
  | { type: "project/setSelection"; selection: TimeRange }
  | { type: "project/setQuality"; quality: DownloadQuality }
  | { type: "silence/setAnalysis"; detectedRegions: TimeRange[] }
  | { type: "silence/toggleAccepted"; region: TimeRange }
  | { type: "silence/splitAccepted"; index: number; atUs: number }
  | { type: "silence/mergeAccepted"; firstIndex: number; secondIndex: number }
  | { type: "silence/disableRemoval" }
  | { type: "overlay/add"; overlay: EditorOverlay }
  | { type: "overlay/remove"; id: string }
  | { type: "overlay/updateGeometry"; id: string; geometry: NormalizedGeometry }
  | { type: "overlay/updateOpacity"; id: string; opacity: number }
  | { type: "overlay/setAspectLock"; id: string; locked: boolean }
  | { type: "captions/setTrack"; track: CaptionTrack }
  | { type: "captions/setEnabled"; enabled: boolean }
  | { type: "captions/updateStyle"; patch: Partial<CaptionStyle> }
  | { type: "navigation/goTo"; step: EditorStep }
  | { type: "navigation/skip" }
  | { type: "playhead/set"; valueUs: number }
  | { type: "history/undo" }
  | { type: "history/redo" };

const HISTORY_LIMIT = 100;
const DEFAULT_FRAME_RATE: FrameRate = { numerator: 30_000, denominator: 1_001 };

export function createDefaultCaptionStyle(): CaptionStyle {
  return {
    sizePercent: 4.5,
    textColor: "#ffffff",
    outlineColor: "#000000",
    outlineWidth: 1.2,
    shadow: 2,
    shadowColor: "#000000",
    backgroundEnabled: false,
    backgroundColor: "#000000",
    backgroundOpacity: 55,
    verticalPosition: "bottom",
    horizontalPosition: "center",
    marginPercent: 7,
    bold: false,
    italic: false,
    fontPath: null,
  };
}

function createEmptyCaptionTrack(): CaptionTrack {
  return {
    enabled: false,
    cues: [],
    style: createDefaultCaptionStyle(),
  };
}

function createInitialProject(): EditorProject {
  return {
    schemaVersion: 1,
    source: { kind: "none", downloadQuality: "best" },
    selection: null,
    silence: { detectedRegions: [], acceptedRemovedRegions: [] },
    overlays: [],
    captions: createEmptyCaptionTrack(),
    export: { width: 1920, height: 1080, frameRate: DEFAULT_FRAME_RATE },
  };
}

export function createInitialEditorState(): EditorState {
  return {
    project: createInitialProject(),
    activeStep: "Source",
    playheadUs: 0,
    sourceStatus: { kind: "idle" },
    history: [],
    future: [],
  };
}

function withProject(state: EditorState, project: EditorProject): EditorState {
  return {
    ...state,
    project,
    history: [...state.history, state.project].slice(-HISTORY_LIMIT),
    future: [],
  };
}

export function sourceDurationUs(project: EditorProject): number {
  if (project.source.kind === "none") return 0;
  return project.source.metadata.duration;
}

export function projectFrameRate(project: EditorProject): FrameRate {
  if (project.source.kind === "local") return project.source.metadata.frameRate;
  return project.export.frameRate;
}

export function requiresNarrowerYouTubeRange(project: EditorProject): boolean {
  if (project.source.kind !== "youtube") return false;
  const selection = project.selection;
  return (
    selection === null ||
    (selection.start === 0 && selection.end === project.source.metadata.duration)
  );
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "source/localLoaded": {
      const project: EditorProject = {
        ...state.project,
        source: {
          kind: "local",
          path: action.path,
          metadata: action.metadata,
          downloadQuality: "best",
        },
        selection: { start: 0, end: action.metadata.duration },
        silence: { detectedRegions: [], acceptedRemovedRegions: [] },
        overlays: [],
        captions: createEmptyCaptionTrack(),
        export: {
          width: action.metadata.width,
          height: action.metadata.height,
          frameRate: action.metadata.frameRate,
        },
      };
      return {
        ...withProject(state, project),
        playheadUs: 0,
        sourceStatus: { kind: "ready", message: "المصدر المحلي جاهز" },
      };
    }
    case "source/youtubeLoaded": {
      const project: EditorProject = {
        ...state.project,
        source: {
          kind: "youtube",
          url: action.url,
          metadata: action.metadata,
          downloadQuality: "best",
        },
        selection: { start: 0, end: action.metadata.duration },
        silence: { detectedRegions: [], acceptedRemovedRegions: [] },
        overlays: [],
        captions: createEmptyCaptionTrack(),
      };
      return {
        ...withProject(state, project),
        playheadUs: 0,
        sourceStatus: { kind: "ready", message: "بيانات يوتيوب جاهزة" },
      };
    }
    case "source/setStatus":
      return { ...state, sourceStatus: action.status };
    case "project/load":
      return {
        ...state,
        project: action.project,
        playheadUs: action.project.selection?.start ?? 0,
        sourceStatus: action.sourceStatus ?? { kind: "ready", message: "تم تحميل المشروع" },
        history: [],
        future: [],
      };
    case "project/setSelection":
      return withProject(state, { ...state.project, selection: action.selection });
    case "project/setQuality":
      return withProject(state, {
        ...state.project,
        source: { ...state.project.source, downloadQuality: action.quality },
      });
    case "silence/setAnalysis": {
      const detectedRegions = action.detectedRegions.map((region) => ({ ...region }));
      const acceptedRemovedRegions = action.detectedRegions.map((region) => ({ ...region }));
      return withProject(state, {
        ...state.project,
        silence: { detectedRegions, acceptedRemovedRegions },
      });
    }
    case "silence/toggleAccepted": {
      const accepted = state.project.silence.acceptedRemovedRegions;
      const covered = isRangeCovered(action.region, accepted);
      const withoutOverlaps = accepted.filter(
        (region) => region.end <= action.region.start || region.start >= action.region.end,
      );
      const acceptedRemovedRegions = covered
        ? withoutOverlaps
        : [...withoutOverlaps, { ...action.region }].sort((left, right) => left.start - right.start);
      return withProject(state, {
        ...state.project,
        silence: { ...state.project.silence, acceptedRemovedRegions },
      });
    }
    case "silence/splitAccepted": {
      const accepted = state.project.silence.acceptedRemovedRegions;
      const region = accepted[action.index];
      if (!region || action.atUs <= region.start || action.atUs >= region.end) return state;
      const acceptedRemovedRegions = [
        ...accepted.slice(0, action.index),
        { start: region.start, end: action.atUs },
        { start: action.atUs, end: region.end },
        ...accepted.slice(action.index + 1),
      ];
      return withProject(state, {
        ...state.project,
        silence: { ...state.project.silence, acceptedRemovedRegions },
      });
    }
    case "silence/mergeAccepted": {
      const accepted = state.project.silence.acceptedRemovedRegions;
      const first = accepted[action.firstIndex];
      const second = accepted[action.secondIndex];
      if (!first || !second || action.firstIndex === action.secondIndex) return state;
      const left = first.start <= second.start ? first : second;
      const right = left === first ? second : first;
      if (left.end < right.start) return state;
      const remove = new Set([action.firstIndex, action.secondIndex]);
      const acceptedRemovedRegions = accepted
        .filter((_, index) => !remove.has(index))
        .concat({ start: Math.min(first.start, second.start), end: Math.max(first.end, second.end) })
        .sort((a, b) => a.start - b.start);
      return withProject(state, {
        ...state.project,
        silence: { ...state.project.silence, acceptedRemovedRegions },
      });
    }
    case "silence/disableRemoval":
      return withProject(state, {
        ...state.project,
        silence: { ...state.project.silence, acceptedRemovedRegions: [] },
      });
    case "overlay/add":
      return withProject(state, {
        ...state.project,
        overlays: [...state.project.overlays, action.overlay],
      });
    case "overlay/remove":
      return withProject(state, {
        ...state.project,
        overlays: state.project.overlays.filter((overlay) => overlay.id !== action.id),
      });
    case "overlay/updateGeometry":
      return withProject(state, {
        ...state.project,
        overlays: state.project.overlays.map((overlay) =>
          overlay.id === action.id ? { ...overlay, geometry: action.geometry } : overlay,
        ),
      });
    case "overlay/updateOpacity":
      return withProject(state, {
        ...state.project,
        overlays: state.project.overlays.map((overlay) =>
          overlay.id === action.id
            ? { ...overlay, opacity: Math.max(0, Math.min(1, action.opacity)) }
            : overlay,
        ),
      });
    case "overlay/setAspectLock":
      return withProject(state, {
        ...state.project,
        overlays: state.project.overlays.map((overlay) =>
          overlay.id === action.id ? { ...overlay, aspectLocked: action.locked } : overlay,
        ),
      });
    case "captions/setTrack":
      return withProject(state, {
        ...state.project,
        captions: {
          ...action.track,
          cues: action.track.cues.map((cue) => ({ ...cue })),
          style: { ...action.track.style },
        },
      });
    case "captions/setEnabled":
      return withProject(state, {
        ...state.project,
        captions: { ...state.project.captions, enabled: action.enabled },
      });
    case "captions/updateStyle":
      return withProject(state, {
        ...state.project,
        captions: {
          ...state.project.captions,
          style: { ...state.project.captions.style, ...action.patch },
        },
      });
    case "navigation/goTo":
      return { ...state, activeStep: action.step };
    case "navigation/skip": {
      const current = EDITOR_STEPS.indexOf(state.activeStep);
      const next = EDITOR_STEPS[Math.min(current + 1, EDITOR_STEPS.length - 1)];
      return { ...state, activeStep: next };
    }
    case "playhead/set": {
      const duration = sourceDurationUs(state.project);
      const next = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Math.round(action.valueUs)));
      return { ...state, playheadUs: next };
    }
    case "history/undo": {
      const project = state.history.at(-1);
      if (!project) return state;
      return {
        ...state,
        project,
        history: state.history.slice(0, -1),
        future: [...state.future, state.project].slice(-HISTORY_LIMIT),
      };
    }
    case "history/redo": {
      const project = state.future.at(-1);
      if (!project) return state;
      return {
        ...state,
        project,
        history: [...state.history, state.project].slice(-HISTORY_LIMIT),
        future: state.future.slice(0, -1),
      };
    }
  }
}

function sameRange(left: TimeRange, right: TimeRange): boolean {
  return left.start === right.start && left.end === right.end;
}

export function isRangeCovered(target: TimeRange, ranges: TimeRange[]): boolean {
  const relevant = ranges
    .filter((range) => range.end > target.start && range.start < target.end)
    .sort((left, right) => left.start - right.start);
  let cursor = target.start;
  for (const range of relevant) {
    if (range.start > cursor) return false;
    cursor = Math.max(cursor, range.end);
    if (cursor >= target.end) return true;
  }
  return false;
}
