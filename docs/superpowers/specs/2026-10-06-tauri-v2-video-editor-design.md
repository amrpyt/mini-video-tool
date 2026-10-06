# Mini Video Tool v2 — Design Specification

Date: 2026-10-06
Status: Approved design, pre-implementation

## 1. Product intent

Mini Video Tool v2 is a local-first Windows video editor focused on one fast workflow:

1. choose a local video or YouTube source;
2. choose the wanted range;
3. optionally review silence cuts;
4. optionally add images, logo, and bars;
5. optionally add and style captions;
6. preview edits without rendering;
7. export once.

The application must feel like a polished commercial desktop product while remaining intentionally small. It is not a general-purpose NLE and must not grow speculative infrastructure.

"Web-based" in this design means a local React web UI hosted inside the Tauri desktop shell. It does not mean a hosted website, remote backend, or browser-only SaaS.

Primary success criteria:

- The workflow is obvious without documentation.
- Every editing step is skippable and reversible.
- The complete source timeline remains visible while the selected range is highlighted.
- Previewing ordinary edits does not run a heavy render.
- Trim, silence removal, overlays, captions, and sync are compiled into one final FFmpeg render whenever technically possible.
- All media processing stays on the user's machine.
- Existing v1 correctness lessons are preserved during the rewrite.

## 2. Engineering principles

### 2.1 Local-first

No account, cloud service, remote database, hosted backend, analytics service, or mandatory network dependency beyond explicit YouTube access.

Projects, media references, temp files, preferences, and exported files live locally.

### 2.2 Modular monolith

Use one desktop application with clear internal boundaries. Do not introduce microservices, plugin systems, repositories around plain JSON, factories for single implementations, or interfaces without a real substitution need.

### 2.3 Ponytail Ultra

Prefer, in order:

1. deleting unnecessary work;
2. existing platform capability;
3. standard library;
4. already-required dependency;
5. the smallest new dependency or code that solves the measured problem.

Do not simplify away data safety, cancellation, accessibility, validation, or tests for non-trivial logic.

### 2.4 Non-destructive editing

Editing changes project state, not source media. The source file remains unchanged. Heavy transformation occurs only during final export.

### 2.5 One final encode

No stage may create an intermediate rendered video merely to feed the next stage.

The normal export path is:

`ProjectState -> RenderPlan -> one FFmpeg filter graph -> one encode -> final file`

Analysis, metadata reads, thumbnail generation, frame extraction, and audio analysis are not considered renders.

Lossless stream-copy/remux steps required to make a downloaded section locally usable are allowed because they do not re-encode media. They must not become hidden intermediate encode stages.

## 3. Technology decisions

### 3.1 Desktop shell

Use Tauri 2.

Responsibilities:

- host the local web UI;
- expose a narrow typed command surface to Rust;
- package required sidecar executables;
- restrict filesystem and shell access using Tauri permissions/capabilities.

### 3.2 Frontend

Use:

- React;
- TypeScript;
- Vite;
- Tailwind CSS;
- shadcn/ui components where they reduce custom UI code.

Do not use Next.js. This is a local desktop application with no SSR, SEO, hosted routing, or server framework need.

Do not use Remotion in v2 initially. Native `<video>` playback plus React overlays is sufficient for the required preview. Add another rendering abstraction only if a measured requirement cannot be met without it.

### 3.3 Rust core

Rust owns:

- domain state;
- time/range math;
- project persistence;
- source probing;
- YouTube orchestration;
- silence analysis;
- render-plan compilation;
- child-process management;
- cancellation;
- temp ownership and cleanup;
- export execution;
- structured progress and errors.

### 3.4 Media engines

Ship and execute as Tauri sidecars:

- `ffmpeg.exe`;
- `ffprobe.exe`;
- `yt-dlp.exe`.

Do not use Rust FFmpeg bindings in v2 unless a future requirement proves external-process FFmpeg insufficient.

## 4. High-level architecture

```text
React/Vite UI
     |
     | typed Tauri commands/events
     v
Rust application boundary
     |
     +-- domain/      pure project and timeline logic
     +-- media/       ffmpeg, ffprobe, yt-dlp adapters
     +-- jobs/        single heavy-job lifecycle
     +-- commands/    thin Tauri command surface
```

Recommended initial Rust layout:

```text
src-tauri/src/
  domain/
    project.rs
    timeline.rs
    render_plan.rs
  media/
    ffmpeg.rs
    ffprobe.rs
    ytdlp.rs
  jobs/
    manager.rs
  commands/
    source.rs
    analysis.rs
    export.rs
  lib.rs
```

Recommended initial frontend layout:

```text
src/
  app/
  features/
    source/
    range/
    silence/
    design/
    captions/
    export/
  components/
  lib/
```

These are boundaries, not quotas. Merge files when a module is too small to justify its own file.

## 5. User experience

### 5.1 Workspace, not separate applications

Use one persistent editor workspace with three primary regions:

```text
+------------------------------------------------------------------+
| Source -> Range -> Silence -> Design -> Captions -> Export       |
+----------------------------------------------+-------------------+
|                                              |                   |
|                  Preview                     |     Inspector     |
|                                              |                   |
+----------------------------------------------+-------------------+
|                     Timeline                                     |
+------------------------------------------------------------------+
```

The preview and timeline remain mounted while steps change. Step changes update tools and inspector content, not the whole workspace.

### 5.2 Stepper

Steps:

1. Source
2. Range
3. Silence
4. Design
5. Captions
6. Export

Requirements:

- every optional step can be skipped;
- previous steps can be reopened at any time;
- current project state is preserved when moving between steps;
- Export remains reachable without forcing unused steps;
- navigation never triggers a render.

### 5.3 Source step

Source modes:

- local file;
- YouTube URL.

Show immediately when available:

- title or filename;
- total duration;
- dimensions;
- frame rate;
- selected quality;
- thumbnail/poster;
- source type and status.

For YouTube, prefer metadata and available thumbnail/storyboard information before downloading media. Only download the requested range after the user has selected it.

### 5.4 Range step

Always show the complete source duration on the timeline. The selected range is highlighted; content outside it is dimmed, not hidden.

Support all of these range-entry methods:

- drag start/end handles;
- editable `HH:MM:SS.mmm` fields;
- set start to current playhead;
- set end to current playhead;
- `I` keyboard shortcut for in point;
- `O` keyboard shortcut for out point;
- paste a timestamp into a time field;
- frame-step near boundaries.

The UI must prevent invalid ranges rather than allowing export to discover them later.

### 5.5 Professional timeline

The timeline represents source time, not output time.

Initial tracks:

```text
Video      full source strip
Filmstrip  lightweight thumbnails
Waveform   audio overview when available
Cuts       proposed/accepted silence regions
Captions   caption cues
Overlays   timed overlay items
```

Required interactions:

- scrub playhead;
- zoom in/out;
- horizontally pan when zoomed;
- fit full source;
- select in/out range;
- show accepted silence cuts distinctly from detected suggestions;
- select overlay/caption items;
- snapping to relevant boundaries;
- keyboard seek and frame-step;
- clear current-time display.

Do not reproduce full Premiere/Resolve track machinery. Only add editing affordances needed by this product.

### 5.6 Silence step

Silence analysis is non-destructive.

Store separately:

- detected regions;
- regions the user accepted for removal.

The user may:

- keep a detected region;
- remove it;
- split a region;
- merge adjacent regions when valid;
- disable silence removal entirely.

No new video file is produced by silence analysis.

### 5.7 Design step

Supported overlay kinds in v2 initial scope:

- image/logo;
- black bar/rectangle.

Preview manipulation:

- drag;
- resize;
- optional aspect-ratio lock;
- opacity where applicable;
- safe-area guides;
- alignment guides;
- start/end timing on the timeline.

Overlay geometry uses normalized coordinates so preview resolution and export resolution do not change placement.

### 5.8 Captions step

Supported sources:

- YouTube captions when available;
- imported SRT;
- imported ASS.

Support:

- enable/disable;
- editable caption style;
- caption cue timeline;
- click cue to seek;
- live visual preview in React.

The same caption data used by preview is remapped by the RenderPlan compiler for final output, preventing a second timing model.

### 5.9 Export step

Show a concise summary before export:

- source;
- selected range;
- number of accepted silence cuts;
- overlays count;
- captions on/off;
- resolution;
- encoder mode;
- output path/name.

Primary call to action: `Export Final Video`.

The UI explicitly states that all selected edits are applied in one final render.

## 6. Preview architecture

Preview must avoid expensive work wherever possible.

### 6.1 YouTube before download

Use metadata, thumbnail, and available storyboard/preview imagery to provide immediate context before media download.

Do not download the full video simply to choose a range.

### 6.2 Local/downloaded media

Use native web video playback through a tightly scoped local asset path/protocol.

If the WebView cannot decode a source codec/container, do not automatically transcode the whole source into a preview proxy. Fall back to lightweight extracted stills/filmstrip frames for editing context; add a preview proxy only if later usability evidence proves stills insufficient.

React renders editor-only visual layers above the video:

- image/logo overlays;
- bars;
- captions;
- selection/safe-area handles.

Moving or styling these elements must not spawn FFmpeg.

### 6.3 Preview parity

Preview and export share the same normalized geometry, source-time spans, and caption style model. The frontend may approximate font rasterization differences inherent to browser versus libass, but position, timing, sizing intent, and style fields must come from one project model.

## 7. Domain model

### 7.1 Time representation

Use integer media time as the canonical representation:

```rust
struct MediaTime(i64); // microseconds
```

Do not use floating-point seconds as authoritative timeline state.

Frames are a display/navigation concept derived from source frame rate, not the canonical time representation.

### 7.2 ProjectState

Conceptual shape:

```text
Project
  schema_version
  id
  source
  selection
  silence
  overlays
  captions
  export
```

`ProjectState` is the source of truth for user intent.

### 7.3 Source

Represents either local media or YouTube media and stores only required metadata, such as:

- original path or URL;
- duration;
- dimensions;
- frame rate;
- relevant codec/stream metadata;
- local downloaded-range path when one exists;
- source-to-local timing offset needed for keyframe preroll.

The domain remains expressed in original source time even if downloaded media starts before the selected source timestamp because of keyframe alignment.

### 7.4 Selection

Contains the source-time `in_point` and `out_point`.

All optional edits must be valid within or intersected against this selection at compile time.

### 7.5 Silence model

Contains detected regions and accepted removed regions separately.

At render-plan compilation:

`selection - accepted_removed_regions = keep_segments`

Overlapping/adjacent ranges are normalized before FFmpeg graph generation.

### 7.6 Overlay model

Conceptual shape:

```text
Overlay
  id
  kind
  source_span
  geometry
  opacity
  asset_path
```

`kind` initially supports `Image` and `BlackBar` only.

Geometry is normalized to `[0,1]` coordinates for x, y, width, and height.

### 7.7 Caption model

Conceptual shape:

```text
CaptionTrack
  source
  cues
  style
  enabled
```

Cues are stored in source time.

### 7.8 Source-time to output-time mapping

All editing decisions are stored in source time.

The RenderPlan compiler computes the deterministic mapping from source time to output time after removed ranges are excluded.

This mapping is the only place that retimes:

- captions;
- overlay visibility spans;
- resulting duration;
- any other timed edit metadata.

This prevents independent retiming logic from drifting between features.

## 8. RenderPlan

`RenderPlan` is an immutable execution description compiled from validated project state.

It contains only resolved execution decisions, including:

- input media;
- keep segments;
- audio/video timing normalization;
- output-time caption cues;
- output-time overlay spans;
- prepared asset requirements;
- encoder selection;
- output settings;
- final destination.

The function that compiles `ProjectState -> RenderPlan` must be pure Rust with no Tauri, filesystem, subprocess, or FFmpeg dependency.

This compiler is the main correctness boundary of the product.

## 9. Export pipeline

Normal export sequence:

```text
validate project
  -> compile RenderPlan
  -> prepare transient assets
  -> generate FFmpeg graph/arguments
  -> run one FFmpeg encode
  -> validate output
  -> atomically publish final file
```

### 9.1 One render rule

The FFmpeg graph combines, where needed:

- trim/keep segments;
- concat;
- timestamp normalization;
- audio sync;
- image overlays;
- bars;
- subtitles/captions;
- final encoding.

Intermediate encoded video is forbidden in the normal path.

If a future edge case genuinely requires an intermediate encode, it must be documented as an exception with a reproducible technical reason and test coverage.

### 9.2 Encoder selection

Default UI mode: `Auto`.

The Rust encoder selector chooses from known available encoders using measured device behavior and media characteristics.

For the current Intel Core Ultra 5 125H / Intel Arc target, preserve the measured strategy from v1: QSV for workloads where it is faster, CPU for small frames where CPU is faster, with a safe CPU fallback when QSV initialization fails.

Encoder policy belongs in one Rust module/function, never duplicated in UI feature code.

## 10. Jobs and cancellation

Allow one heavy media job at a time in v2 initial scope.

Heavy jobs include:

- YouTube download;
- silence analysis;
- final export.

Normal editor interactions and project saves remain available while appropriate.

Canonical job states:

```text
Queued
Running
Cancelling
Completed
Failed
Cancelled
```

Job progress may expose:

- stage;
- progress fraction/percent;
- speed;
- ETA;
- concise message.

One Job Manager owns child-process registration and cancellation. Features must not implement independent process-kill logic.

On cancel:

1. mark cancel requested;
2. terminate the owned process tree;
3. stop accepting success finalization for that job;
4. remove only temp artifacts owned by the job;
5. preserve source files, completed downloads that are valid user assets, projects, and prior final outputs.

## 11. Files and persistence

### 11.1 Project files

Use a versioned local JSON document, initially with the `.mvt` extension.

Example top-level structure:

```json
{
  "schemaVersion": 1,
  "source": {},
  "selection": {},
  "silence": {},
  "overlays": [],
  "captions": {},
  "export": {}
}
```

No SQLite in initial v2.

### 11.2 Safe saves

Project saves use:

1. write sibling temp file;
2. flush/sync sufficiently for the platform;
3. atomic replacement/rename where supported.

Never rewrite the only valid project copy in place without a recoverable step.

Editor changes should be debounced into a local recovery/autosave copy so an application crash does not discard recent project-state edits. Autosave never modifies source media or publishes a final output.

### 11.3 Job workspace

Every heavy job gets an owned temp directory beneath the application's local data/temp area.

It may contain:

- generated ASS;
- resized/prepared static images;
- FFmpeg filter scripts;
- temporary output.

Cleanup is scoped to that job only.

### 11.4 Safe final output

Render to a same-destination-filesystem temporary sibling where practical, validate success, then publish atomically to the requested final path.

Cancellation or failure must never destroy a previously valid final file.

## 12. Security boundary

The frontend cannot execute arbitrary shell strings.

React sends structured commands such as:

```text
analyze_source(...)
analyze_silence(...)
download_range(...)
save_project(...)
export_project(...)
cancel_job(...)
```

Rust validates all inputs and constructs process arguments directly without passing user strings through a shell parser.

Tauri filesystem/shell permissions must be scoped to the minimum required paths and sidecars.

## 13. Error handling

Use structured internal errors, initially covering:

```text
InvalidInput
SourceUnavailable
MediaProbeFailed
DownloadFailed
AnalysisFailed
ExportFailed
DiskFull
Cancelled
UnsupportedMedia
```

Each error may carry technical context for diagnostics, but user-facing messages are concise and actionable.

Example:

`Intel Quick Sync could not start for this file. Export continued using CPU.`

Raw FFmpeg/yt-dlp diagnostics belong behind an optional technical-details affordance, not in the primary error message.

## 14. Undo and redo

Undo/redo applies to editing decisions in `ProjectState`, not to filesystem mutations or completed external jobs.

Keep the implementation small: use bounded project-state/history actions sufficient for editor changes. Do not introduce event sourcing or a generic command framework unless the simple history model proves insufficient.

## 15. Accessibility and RTL

Arabic RTL is a first-class requirement.

Requirements:

- correct document/component direction where appropriate;
- logical start/end spacing rather than left/right assumptions;
- keyboard navigation for primary controls;
- visible focus states;
- labels/tooltips for icon-only controls;
- sufficient contrast;
- timeline keyboard alternatives for pointer actions;
- text inputs remain predictable for timestamps and filenames.

## 16. Performance rules

The following actions must not start FFmpeg or another heavy subprocess:

- moving an overlay;
- resizing an overlay;
- changing caption style;
- changing steps;
- dragging the playhead;
- editing in/out time fields;
- toggling a silence-region decision already present in analysis data;
- saving project JSON.

Heavy processing is limited to actions that inherently need media work:

- source probing;
- requested YouTube range download;
- silence analysis;
- lightweight frame/thumbnail extraction when no cheaper preview data exists;
- final export.

Any regression that starts a render for an ordinary editor interaction is an architectural defect.

## 17. Testing strategy

Favor high-value deterministic tests over arbitrary coverage targets.

### 17.1 Rust unit tests

Must cover non-trivial domain logic, especially:

- `MediaTime` operations;
- range validation/normalization;
- silence subtraction;
- keep-segment generation;
- source-time to output-time mapping;
- overlay span mapping;
- caption span mapping;
- RenderPlan compilation;
- encoder policy decisions.

### 17.2 Command/filter generation tests

Given a known RenderPlan, verify important FFmpeg arguments/filter graph structure without launching FFmpeg.

### 17.3 Real media integration tests

Maintain a small set of generated or redistributable fixtures covering:

- video plus audio;
- silence regions;
- non-zero stream start offsets;
- PNG overlay;
- captions.

Run real FFmpeg/ffprobe against these fixtures and verify relevant output facts such as duration, streams, dimensions, timestamps, and codec.

### 17.4 Frontend behavior tests

Test only product-critical behavior such as:

- step skipping/navigation;
- valid/invalid range editing;
- project-state updates from timeline actions;
- undo/redo;
- important selection interactions.

Do not create brittle tests for cosmetic implementation details.

### 17.5 End-to-end smoke

At least one Windows smoke flow must verify:

`open app -> load fixture -> select range -> add overlay -> enable captions -> export -> validate output`

## 18. Migration from Python v1

Python v1 remains the stable behavioral reference while v2 is built.

Do not create Python/Rust runtime interoperability. Reuse knowledge and test cases, not the old runtime.

Preserve and re-test lessons already learned in v1, including:

- YouTube partial download and keyframe preroll behavior;
- stream timestamp normalization;
- audio/video synchronization;
- caption timing after source offsets/cuts;
- QSV detection and CPU fallback;
- safe cancellation of process trees;
- temp-output ownership;
- protection of completed downloads and prior outputs during cancellation;
- static-overlay preparation;
- progress telemetry.

Keep v1 releases/tags available until v2 passes its cutover gate.

## 19. Cutover gate

v2 may replace v1 as the primary release only after fresh verification of all of the following:

- local video source;
- YouTube partial-range workflow;
- quality selection;
- complete-source timeline with highlighted selection;
- all specified range-entry methods;
- silence detection and review;
- image/logo overlays;
- black bar overlays;
- caption import/download and styling;
- preview without routine rendering;
- cancellation;
- progress/telemetry;
- adaptive hardware/CPU encoding;
- safe temp/final-output handling;
- RTL usability;
- keyboard workflow;
- one-final-render architecture;
- output timing/sync correctness against integration fixtures;
- comparable or better real-device performance on representative files.

The old Python implementation is frozen, not deleted, until this gate passes.

## 20. Explicitly out of scope for initial v2

Do not build these unless a later requirement justifies them:

- cloud sync;
- authentication/accounts;
- SaaS backend;
- collaboration;
- remote render workers;
- database server;
- generic plugin system;
- arbitrary text/effects editor;
- multi-camera editing;
- color grading suite;
- multi-project render farm;
- telemetry collection service;
- FFmpeg Rust bindings;
- event sourcing;
- microservices.

## 21. Acceptance summary

The design is successful when a new user can move from source to export without wondering which tab or intermediate file to use, while an engineer can explain the runtime in one sentence:

> The UI edits a local ProjectState; Rust compiles it into one deterministic RenderPlan; FFmpeg executes that plan once at export.
