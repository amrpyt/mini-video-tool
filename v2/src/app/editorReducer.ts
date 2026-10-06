import type {
  DownloadQuality,
  FrameRate,
  SourceMetadata,
  TimeRange,
  YouTubeMetadata,
} from "../lib/types";

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
  overlays: unknown[];
  captions: {
    enabled: boolean;
    cues: unknown[];
    style: Record<string, never>;
  };
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
  | { type: "project/setSelection"; selection: TimeRange }
  | { type: "project/setQuality"; quality: DownloadQuality }
  | { type: "navigation/goTo"; step: EditorStep }
  | { type: "navigation/skip" }
  | { type: "playhead/set"; valueUs: number }
  | { type: "history/undo" }
  | { type: "history/redo" };

const HISTORY_LIMIT = 100;
const DEFAULT_FRAME_RATE: FrameRate = { numerator: 30_000, denominator: 1_001 };

function createInitialProject(): EditorProject {
  return {
    schemaVersion: 1,
    source: { kind: "none", downloadQuality: "best" },
    selection: null,
    silence: { detectedRegions: [], acceptedRemovedRegions: [] },
    overlays: [],
    captions: { enabled: false, cues: [], style: {} },
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
      };
      return {
        ...withProject(state, project),
        playheadUs: 0,
        sourceStatus: { kind: "ready", message: "بيانات يوتيوب جاهزة" },
      };
    }
    case "source/setStatus":
      return { ...state, sourceStatus: action.status };
    case "project/setSelection":
      return withProject(state, { ...state.project, selection: action.selection });
    case "project/setQuality":
      return withProject(state, {
        ...state.project,
        source: { ...state.project.source, downloadQuality: action.quality },
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
