import type { EditorProject } from "./editorReducer";
import type { CanonicalExportProject, ResolvedDownload } from "../lib/types";

export interface HydratedProject {
  project: EditorProject;
  resolvedYouTube: ResolvedDownload | null;
}

export function toProjectDocument(
  project: EditorProject,
  resolvedYouTube: ResolvedDownload | null = null,
): CanonicalExportProject {
  const source =
    project.source.kind === "local"
      ? {
          path: project.source.path,
          metadata: project.source.metadata,
          url: null,
          youtubeMetadata: null,
          resolvedPath: null,
          sourceOffset: null,
          resolvedMetadata: null,
          downloadQuality: project.source.downloadQuality,
        }
      : project.source.kind === "youtube"
        ? {
            path: null,
            metadata: null,
            url: project.source.url,
            youtubeMetadata: project.source.metadata,
            resolvedPath: resolvedYouTube?.path ?? null,
            sourceOffset: resolvedYouTube?.sourceOffset ?? null,
            resolvedMetadata: resolvedYouTube?.metadata ?? null,
            downloadQuality: project.source.downloadQuality,
          }
        : {
            path: null,
            metadata: null,
            url: null,
            youtubeMetadata: null,
            resolvedPath: null,
            sourceOffset: null,
            resolvedMetadata: null,
            downloadQuality: project.source.downloadQuality,
          };

  return {
    schemaVersion: project.schemaVersion,
    source,
    selection: project.selection ? { ...project.selection } : null,
    silence: {
      detectedRegions: project.silence.detectedRegions.map((range) => ({ ...range })),
      acceptedRemovedRegions: project.silence.acceptedRemovedRegions.map((range) => ({ ...range })),
    },
    overlays: project.overlays.map((overlay) => ({
      ...overlay,
      range: { ...overlay.range },
      geometry: { ...overlay.geometry },
    })),
    captions: {
      enabled: project.captions.enabled,
      cues: project.captions.cues.map((cue) => ({ ...cue })),
      style: { ...project.captions.style },
    },
    export: {
      width: project.export.width,
      height: project.export.height,
      frameRate: { ...project.export.frameRate },
    },
  };
}

export function fromProjectDocument(document: CanonicalExportProject): HydratedProject {
  const source =
    document.source.url && document.source.youtubeMetadata
      ? {
          kind: "youtube" as const,
          url: document.source.url,
          metadata: document.source.youtubeMetadata,
          downloadQuality: document.source.downloadQuality,
        }
      : document.source.path && document.source.metadata
        ? {
            kind: "local" as const,
            path: document.source.path,
            metadata: document.source.metadata,
            downloadQuality: document.source.downloadQuality,
          }
        : {
            kind: "none" as const,
            downloadQuality: document.source.downloadQuality,
          };

  const resolvedYouTube =
    source.kind === "youtube" &&
    document.source.resolvedPath &&
    document.source.resolvedMetadata &&
    document.source.sourceOffset !== null &&
    document.source.sourceOffset !== undefined
      ? {
          path: document.source.resolvedPath,
          sourceOffset: document.source.sourceOffset,
          metadata: document.source.resolvedMetadata,
        }
      : null;

  return {
    project: {
      schemaVersion: document.schemaVersion,
      source,
      selection: document.selection ? { ...document.selection } : null,
      silence: {
        detectedRegions: document.silence.detectedRegions.map((range) => ({ ...range })),
        acceptedRemovedRegions: document.silence.acceptedRemovedRegions.map((range) => ({ ...range })),
      },
      overlays: document.overlays.map((overlay) => ({
        ...overlay,
        range: { ...overlay.range },
        geometry: { ...overlay.geometry },
      })),
      captions: {
        enabled: document.captions.enabled,
        cues: document.captions.cues.map((cue) => ({ ...cue })),
        style: { ...document.captions.style },
      },
      export: {
        width: document.export.width,
        height: document.export.height,
        frameRate: { ...document.export.frameRate },
      },
    },
    resolvedYouTube,
  };
}
