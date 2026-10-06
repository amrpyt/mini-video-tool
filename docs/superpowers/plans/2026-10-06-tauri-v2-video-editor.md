# Mini Video Tool v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Tauri 2 video editor with a React/Vite web UI, Rust media core, professional source-time timeline, non-destructive edits, lightweight previews, safe cancellation, and one final FFmpeg encode.

**Architecture:** Build v2 in an isolated `v2/` subtree while Python v1 remains frozen as the behavioral reference. React owns interaction and preview state; Rust owns canonical project state, time math, persistence, media orchestration, jobs, and export compilation. FFmpeg/ffprobe/yt-dlp remain external sidecars and only Rust may execute them.

**Tech Stack:** Tauri 2, Rust 1.93+, React, TypeScript, Vite, Tailwind CSS, Vitest + Testing Library, FFmpeg/ffprobe/yt-dlp sidecars, npm.

**Spec:** `docs/superpowers/specs/2026-10-06-tauri-v2-video-editor-design.md`

## Global Constraints

- Windows-first, local-first desktop application; no hosted backend, cloud sync, auth, analytics service, remote database, or SaaS dependency.
- v2 lives under `v2/`; do not delete or rewrite Python v1 during implementation.
- Canonical time is signed integer microseconds: `MediaTime(i64)`.
- All edit decisions are stored in original source time; output time is derived only by the RenderPlan compiler.
- Ordinary editor interactions must not invoke FFmpeg or another heavy subprocess.
- Normal export path is `ProjectState -> RenderPlan -> one FFmpeg filter graph -> one encode -> final file`.
- Lossless stream-copy/remux is allowed when needed to normalize downloaded media; hidden intermediate re-encodes are not.
- React cannot execute arbitrary shell commands. Only Rust constructs and runs sidecar arguments.
- One heavy media job may run at a time in initial v2.
- Cancellation must preserve source files, valid completed downloads, projects, and any prior final output.
- Project files are versioned local JSON using `.mvt`; no SQLite initially.
- Tauri asset exposure must be narrowly scoped; do not expose the whole home drive merely to make preview work.
- Visible editor chrome is Arabic/RTL-first; internal code identifiers stay English and timestamp/path controls use direction appropriate to their content.
- QSV policy preserves v1 measurements: prefer QSV at pixel count `>= 1280 * 720` when available; otherwise CPU, with CPU fallback when QSV initialization fails.
- Use `-/filter_complex <file>` for long FFmpeg graphs; the installed FFmpeg marks `-filter_complex_script` deprecated.
- No Rust FFmpeg bindings, Remotion, Next.js, microservices, plugin system, event sourcing, or speculative abstractions in initial v2.
- Do not bundle or redistribute the local Ping font or any font without distribution rights; caption fonts are system fonts or user-selected local font files.
- Use TDD for non-trivial behavior and fresh verification before completion claims.

## Review Focus

1. **Unicode/space-heavy Windows paths:** Arabic filenames and paths containing spaces must probe, preview, save, and export without shell quoting bugs. Task 5 and Task 10 add explicit argument and real-output tests.
2. **NTSC/non-integer frame rates:** `30000/1001` and similar rates must not corrupt canonical timestamps or frame stepping. Task 2 and Task 6 pin rational frame-step behavior.
3. **Video without an audio stream:** the editor must still load/export the video and make silence analysis unavailable with an actionable message rather than failing. Task 5, Task 8, and Task 10 cover this.
4. **Source missing after reopening a project:** project load must succeed as a recoverable `SourceUnavailable` state instead of corrupting or rejecting the project. Task 2 and Task 11 cover this.
5. **Cancel/failure during final publication:** an existing destination file must survive and a temp result must not be published after cancellation. Task 10 adds race/finalization tests; Task 4 pins the stale-success cancellation race beneath it.

---

### Task 1: Scaffold the isolated Tauri/React v2 shell

**Files:**
- Create: `v2/package.json`
- Create: `v2/package-lock.json`
- Create: `v2/index.html`
- Create: `v2/tsconfig.json`
- Create: `v2/tsconfig.app.json`
- Create: `v2/vite.config.ts`
- Create: `v2/vitest.config.ts`
- Create: `v2/src/main.tsx`
- Create: `v2/src/app/App.tsx`
- Create: `v2/src/app/App.test.tsx`
- Create: `v2/src/styles.css`
- Create: `v2/src-tauri/Cargo.toml`
- Create: `v2/src-tauri/build.rs`
- Create: `v2/src-tauri/src/main.rs`
- Create: `v2/src-tauri/src/lib.rs`
- Create: `v2/src-tauri/tauri.conf.json`
- Create: `v2/src-tauri/capabilities/main-window.json`
- Create: `v2/scripts/stage-sidecars.ps1`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: existing repository `bin/ffmpeg.exe`, `bin/ffprobe.exe`, `bin/yt-dlp.exe`.
- Produces: runnable `v2/` Tauri shell; npm scripts `dev`, `build`, `test`, `tauri`, `stage:sidecars`; Rust library crate `mini_video_tool_v2` available to integration tests.

- [ ] **Step 1: Create the frontend/Rust manifests and test harness only**

Use current stable Tauri 2/React/Vite packages, npm, Vitest, Testing Library, Tailwind, `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `tauri`, `tauri-build`, `tauri-plugin-shell`, `serde`, `serde_json`, `thiserror`, and Windows-only `windows-sys` file-system APIs needed for atomic replace. Do not add a state-management library.

- [ ] **Step 2: Write the failing shell test**

`v2/src/app/App.test.tsx` must render `<App />` and assert the six visible Arabic step labels `المصدر`, `التحديد`, `حذف الصمت`, `التصميم`, `الكابشن`, `التصدير` exist and that no tab content from Python v1 is present. Internal step IDs remain `Source`, `Range`, `Silence`, `Design`, `Captions`, `Export`.

- [ ] **Step 3: Run the test to verify RED**

Run: `cd v2; npm test -- --run src/app/App.test.tsx`

Expected: FAIL because `App` does not yet implement the workspace shell.

- [ ] **Step 4: Implement the minimum Tauri/React shell and sidecar staging**

Create a single-window app with a persistent header/stepper placeholder, preview placeholder, inspector placeholder, and timeline placeholder. `stage-sidecars.ps1` copies the three existing repository binaries into ignored `v2/src-tauri/binaries/*-x86_64-pc-windows-msvc.exe` names required by Tauri `externalBin`; it must fail clearly if any source binary is missing. The frontend capability file must not grant shell execution permissions.

- [ ] **Step 5: Verify shell and builds**

Run:

```powershell
cd v2
npm test -- --run src/app/App.test.tsx
npm run build
cargo test --manifest-path .\src-tauri\Cargo.toml
```

Expected: frontend test PASS; Vite build exits 0; Rust tests/build exit 0.

- [ ] **Step 6: Commit**

```powershell
git add .gitignore v2
git commit -m "build: scaffold tauri v2 editor"
```

---

### Task 2: Canonical time, project model, and safe local persistence

**Files:**
- Create: `v2/src-tauri/src/domain/mod.rs`
- Create: `v2/src-tauri/src/domain/time.rs`
- Create: `v2/src-tauri/src/domain/project.rs`
- Create: `v2/src-tauri/src/project_io.rs`
- Create: `v2/src-tauri/src/error.rs`
- Create: `v2/src-tauri/tests/project_domain.rs`
- Modify: `v2/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: none beyond serde/std.
- Produces:
  - `MediaTime(pub i64)` in microseconds.
  - `FrameRate { numerator: u32, denominator: u32 }`.
  - `TimeRange { start: MediaTime, end: MediaTime }` with validated constructor.
  - `DownloadQuality::{Best, P1080, P720, P480, P360}`.
  - `frame_step(time: MediaTime, frames: i64, rate: FrameRate) -> Result<MediaTime, AppError>`.
  - serializable `Project`, `SourceState`, `SourceMetadata`, `SilenceState`, `Overlay`, `CaptionTrack`, `ExportSettings`.
  - `save_project_atomic(path: &Path, project: &Project) -> Result<(), AppError>`.
  - `load_project(path: &Path) -> Result<Project, AppError>`.
  - `atomic_replace_file(temp: &Path, destination: &Path) -> Result<(), AppError>` using Windows replace semantics and reused by final export.
  - `AppError` variants from the spec.

- [ ] **Step 1: Write failing domain/persistence tests**

Tests must assert:

- `TimeRange::new(10_000_000, 30_000_000)` is valid and zero/negative duration is rejected.
- 30 frames at `30000/1001` advances `1_001_000` microseconds within integer rounding rules and repeated stepping does not use floating-point accumulation.
- Project JSON round-trips `schemaVersion: 1`.
- atomic save replaces a project only after the temp file is complete.
- loading a project whose source path no longer exists still deserializes the project; source availability is a separate runtime status, not a parse failure.

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test --manifest-path v2/src-tauri/Cargo.toml --test project_domain`

Expected: FAIL because domain types and persistence functions do not exist.

- [ ] **Step 3: Implement the minimal domain and atomic persistence**

Use integer arithmetic for frame stepping. Project serialization uses camelCase JSON fields and `schemaVersion = 1`. `save_project_atomic` writes a sibling temp, flushes/syncs it, then calls `atomic_replace_file`; on Windows implement replacement with `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` rather than delete-then-rename.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `cargo test --manifest-path v2/src-tauri/Cargo.toml --test project_domain`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add v2/src-tauri
git commit -m "feat: add v2 project domain"
```

---

### Task 3: Pure RenderPlan compiler and source-to-output mapping

**Files:**
- Create: `v2/src-tauri/src/domain/render_plan.rs`
- Create: `v2/src-tauri/tests/render_plan.rs`
- Modify: `v2/src-tauri/src/domain/mod.rs`

**Interfaces:**
- Consumes: `Project`, `MediaTime`, `TimeRange`, `SourceMetadata` from Task 2.
- Produces:
  - `build_keep_segments(selection: TimeRange, removed: &[TimeRange]) -> Result<Vec<TimeRange>, AppError>`.
  - `map_source_time(keep: &[TimeRange], source: MediaTime) -> Option<MediaTime>`.
  - `ResolvedInput { path: PathBuf, source_offset: MediaTime, metadata: SourceMetadata }`.
  - `EncoderSelection::{CpuX264, IntelQsv}`.
  - immutable `RenderPlan`.
  - `compile_render_plan(project: &Project, input: ResolvedInput, output: PathBuf, encoder: EncoderSelection) -> Result<RenderPlan, AppError>`.

- [ ] **Step 1: Write failing render-plan tests**

Pin these cases:

- selection `10s..30s` minus `15s..17s` produces keep segments `10..15`, `17..30`, duration `18s`.
- overlapping/adjacent removal ranges normalize before subtraction.
- a caption at source `18..20s` maps to output `16..18s` in the example above.
- an overlay spanning a removed boundary is clipped/mapped into valid output spans, never negative time.
- edits completely outside the selection do not enter the plan.
- downloaded keyframe preroll expressed through `source_offset` does not change source-time decisions.

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test --manifest-path v2/src-tauri/Cargo.toml --test render_plan`

Expected: FAIL because the compiler does not exist.

- [ ] **Step 3: Implement the pure compiler**

The module must not import Tauri, spawn processes, inspect the filesystem, or call FFmpeg. Normalize ranges once, derive keep segments once, and use one mapping implementation for captions and overlay timing.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `cargo test --manifest-path v2/src-tauri/Cargo.toml --test render_plan`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add v2/src-tauri/src/domain v2/src-tauri/tests/render_plan.rs
git commit -m "feat: compile deterministic render plans"
```

---

### Task 4: Central heavy-job lifecycle, progress, and cancellation

**Files:**
- Create: `v2/src-tauri/src/jobs/mod.rs`
- Create: `v2/src-tauri/src/jobs/state.rs`
- Create: `v2/src-tauri/src/jobs/manager.rs`
- Create: `v2/src-tauri/src/jobs/windows.rs`
- Create: `v2/src-tauri/tests/job_manager.rs`
- Modify: `v2/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `AppError` from Task 2 and Tauri shell sidecar support from Task 1.
- Produces:
  - `JobKind::{Download, SilenceAnalysis, Export}`.
  - `JobStatus::{Queued, Running, Cancelling, Completed, Failed, Cancelled}`.
  - `JobProgress { stage: String, fraction: Option<f64>, speed: Option<String>, eta_seconds: Option<u64>, message: String }`.
  - `JobManager::begin(kind: JobKind) -> Result<JobId, AppError>` enforcing one heavy job.
  - `JobManager::attach_process(job: JobId, pid: u32) -> Result<(), AppError>`.
  - `JobManager::cancel_active() -> Result<(), AppError>`.
  - `JobManager::finish(job: JobId, outcome: JobOutcome) -> Result<(), AppError>`.
  - `terminate_process_tree(pid: u32) -> io::Result<()>` implemented with `taskkill /PID <pid> /T /F` on Windows, no shell string interpolation.

- [ ] **Step 1: Write failing lifecycle/cancellation tests**

Tests must prove:

- a second heavy job is rejected while one is running;
- cancel transitions `Running -> Cancelling -> Cancelled`;
- stale completion after cancellation cannot transition a job to `Completed`;
- a process attached after cancellation was already requested is terminated immediately and cannot become the active successful process;
- only the active job PID may be terminated;
- the process-tree helper constructs direct arguments rather than a shell command string;

- [ ] **Step 2: Run tests to verify RED**

Run: `cargo test --manifest-path v2/src-tauri/Cargo.toml --test job_manager`

Expected: FAIL because job types do not exist.

- [ ] **Step 3: Implement the state machine and Windows termination helper**

Keep job ownership in one manager guarded by one mutex; no feature-specific process registries. Process output parsing remains in media modules, but lifecycle ownership remains here.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `cargo test --manifest-path v2/src-tauri/Cargo.toml --test job_manager`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add v2/src-tauri/src/jobs v2/src-tauri/tests/job_manager.rs v2/src-tauri/src/lib.rs
git commit -m "feat: centralize media job lifecycle"
```

---

### Task 5: Source probing, YouTube metadata, partial download, and lightweight preview assets

**Files:**
- Create: `v2/src-tauri/src/media/mod.rs`
- Create: `v2/src-tauri/src/media/ffprobe.rs`
- Create: `v2/src-tauri/src/media/ytdlp.rs`
- Create: `v2/src-tauri/src/media/preview.rs`
- Create: `v2/src-tauri/src/commands/mod.rs`
- Create: `v2/src-tauri/src/commands/source.rs`
- Create: `v2/src-tauri/tests/media_source.rs`
- Create: `v2/src/lib/backend.ts`
- Create: `v2/src/lib/types.ts`
- Create: `v2/src/lib/backend.test.ts`
- Modify: `v2/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: domain types from Task 2, `JobManager` from Task 4, staged sidecars from Task 1.
- Produces Rust commands:
  - `probe_source(path: PathBuf) -> Result<SourceMetadata, AppError>`.
  - `youtube_metadata(url: String) -> Result<YouTubeMetadata, AppError>` using `yt-dlp -J`/equivalent metadata-only invocation.
  - `download_range(request: DownloadRangeRequest) -> Result<ResolvedDownload, AppError>` using yt-dlp partial sections only.
  - `extract_preview_frame(request: PreviewFrameRequest) -> Result<PathBuf, AppError>`.
  - `extract_filmstrip(request: FilmstripRequest) -> Result<Vec<PathBuf>, AppError>` for low-resolution local frames after media exists.
  - `parse_ytdlp_progress_line(line: &str) -> Option<JobProgress>` for download telemetry.
- Produces frontend wrappers with the same semantic operations; wrappers call `invoke`, never shell APIs.

- [ ] **Step 1: Write failing Rust command/parser tests**

Tests must assert:

- ffprobe JSON with rational `30000/1001` parses without float frame-rate storage;
- video with no audio parses as `has_audio = false` rather than an error;
- paths like `C:\فيديوهات\My Clip 01.mp4` remain a single process argument;
- yt-dlp metadata parsing returns title, duration, thumbnail URL, qualities, and video ID without media download;
- download args contain `--download-sections` and do not request a full-video fallback;
- a YouTube request whose effective selection equals the complete source duration is rejected as `InvalidInput` rather than silently downloading the full video;
- `Best` remains `bv*+ba/b`, while explicit 1080/720/480/360 selectors prefer HLS H.264, then any HLS, then the existing bounded-quality selector from v1;
- preview extraction uses low-resolution image output and does not encode a video.
- a real tiny fixture stored under a Unicode+space temp path probes with the expected duration/dimensions/audio presence.
- representative yt-dlp progress lines map to structured percent/speed/ETA without throwing on unrelated log lines.

- [ ] **Step 2: Write failing frontend IPC tests**

Using Tauri `mockIPC`, assert `probeSource`, `getYouTubeMetadata`, and `downloadRange` call only the expected command names with structured payloads. Assert no frontend package imports `@tauri-apps/plugin-shell`.

- [ ] **Step 3: Run tests to verify RED**

Run:

```powershell
cargo test --manifest-path v2/src-tauri/Cargo.toml --test media_source
cd v2; npm test -- --run src/lib/backend.test.ts
```

Expected: FAIL because adapters/wrappers do not exist.

- [ ] **Step 4: Implement media adapters and thin source commands**

Run sidecars from Rust using Tauri shell APIs, attach child PIDs to Task 4's manager, and parse stdout/stderr into structured results. Do not expose shell capability to React. Preserve the original source-time offset when keyframe preroll produces a local section beginning before the requested in-point. A completed downloaded media asset remains valid if a later normalization/preview operation is cancelled. Keep the quality-selector builder pure and covered by Step 1 rather than embedding selectors inside the command runner.

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```powershell
cargo test --manifest-path v2/src-tauri/Cargo.toml --test media_source
cd v2; npm test -- --run src/lib/backend.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add v2/src-tauri/src/media v2/src-tauri/src/commands v2/src-tauri/tests/media_source.rs v2/src/lib
git commit -m "feat: add v2 media source pipeline"
```

---

### Task 6: Persistent workspace, source/range flow, and undoable editor state

**Files:**
- Create: `v2/src/app/editorReducer.ts`
- Create: `v2/src/app/editorReducer.test.ts`
- Create: `v2/src/app/EditorWorkspace.tsx`
- Create: `v2/src/components/Stepper.tsx`
- Create: `v2/src/components/Inspector.tsx`
- Create: `v2/src/features/source/SourceStep.tsx`
- Create: `v2/src/features/range/RangeStep.tsx`
- Create: `v2/src/features/range/timeInput.ts`
- Create: `v2/src/features/range/timeInput.test.ts`
- Modify: `v2/src/app/App.tsx`
- Modify: `v2/src/styles.css`

**Interfaces:**
- Consumes: typed backend wrappers from Task 5 and project/time schema mirrored from Task 2.
- Produces:
  - `EditorState { project, activeStep, playheadUs, sourceStatus, history, future }`.
  - `editorReducer(state, action) -> EditorState` with bounded 100-edit undo history for project edits.
  - `parseTimeInput(text: string, durationUs: number): { ok: true; valueUs: number } | { ok: false; error: string }` supporting `HH:MM:SS.mmm`, `MM:SS.mmm`, and plain seconds.
  - persistent six-step workspace whose Preview and Timeline containers never unmount solely due to step navigation.

- [ ] **Step 1: Write failing reducer/time tests**

Assert:

- optional steps can be skipped and revisited without losing project edits;
- undo/redo affects project edit decisions, not current playhead or job status;
- history caps at 100 edit states;
- quality selection changes only project/source settings and does not start a download;
- a local source defaults to full-duration selection while a YouTube full-duration selection is visibly marked as requiring a narrower range before download/export;
- range input accepts `01:31:37.250`, `31:37.250`, and seconds;
- invalid/negative/out-of-duration times return field errors;
- frame-step at `30000/1001` calls the canonical rational conversion rather than accumulating browser floating-point deltas.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd v2; npm test -- --run src/app/editorReducer.test.ts src/features/range/timeInput.test.ts`

Expected: FAIL because reducer/parser do not exist.

- [ ] **Step 3: Implement workspace, reducer, and Source/Range inspectors**

Use React `useReducer`/context only; do not add Zustand/Redux. Source UI exposes `Best`, `1080p`, `720p`, `480p`, `360p` for YouTube and shows metadata/poster before download. Include drag-handle-ready state, editable in/out fields, Arabic start/end actions, keyboard `I`/`O`, and arrow/frame-step hooks. Default local selection is the full source so Range can be skipped; for YouTube, skipping Range preserves the current selection but full-source selection remains invalid under Task 5's no-full-download rule. Keep Arabic/RTL support at layout level while timestamp inputs use LTR direction. Use a dark neutral editor shell with CSS variables, strong focus/selection contrast, an approximately 320px inspector, flexible preview, persistent bottom timeline, default window around 1440x900, and a usable minimum around 1100x720; no decorative glass/gradient effects that reduce readability.

- [ ] **Step 4: Add component behavior test**

Extend `App.test.tsx` to prove Source -> Range -> Export navigation keeps the same preview/timeline DOM nodes and that Skip does not mutate project data.

- [ ] **Step 5: Run tests/build**

Run:

```powershell
cd v2
npm test -- --run src/app src/features/range
npm run build
```

Expected: PASS and build exits 0.

- [ ] **Step 6: Commit**

```powershell
git add v2/src
git commit -m "feat: add guided editor workspace"
```

---

### Task 7: Professional source-time timeline and zero-render preview

**Files:**
- Create: `v2/src/components/timeline/Timeline.tsx`
- Create: `v2/src/components/timeline/Timeline.test.tsx`
- Create: `v2/src/components/timeline/timelineMath.ts`
- Create: `v2/src/components/timeline/timelineMath.test.ts`
- Create: `v2/src/components/Preview.tsx`
- Create: `v2/src/components/Preview.test.tsx`
- Modify: `v2/src-tauri/Cargo.toml`
- Modify: `v2/src-tauri/src/lib.rs`
- Modify: `v2/src-tauri/tauri.conf.json`
- Modify: `v2/src-tauri/capabilities/main-window.json`
- Modify: `v2/src/app/EditorWorkspace.tsx`
- Modify: `v2/src/styles.css`

**Interfaces:**
- Consumes: project state from Task 6, preview/filmstrip backend calls from Task 5.
- Produces:
  - `timeToX(timeUs, viewport) -> number` and `xToTime(x, viewport) -> number`.
  - source-time Timeline with zoom, pan, fit-full-source, playhead scrubbing, range handles, filmstrip lane, Cuts lane, Captions lane, Overlays lane.
  - Preview using native `<video>` when a local playable source is available and still/poster fallback otherwise.

- [ ] **Step 1: Write failing timeline-math tests**

Assert full-duration mapping, zoomed mapping, clamped scrub, in/out handle ordering, snapping to a supplied boundary within a fixed pixel threshold, zoom anchored at the playhead/pointer without a visible jump, and round-trip `time -> x -> time` within one microsecond at representative viewport widths.

- [ ] **Step 2: Write failing preview/timeline behavior tests**

Assert:

- complete source duration remains visible while selection is highlighted/dimmed outside;
- pre-download YouTube state renders title/poster without calling preview-frame extraction;
- moving playhead or range handles does not call any backend command;
- local playable media renders `<video>` plus overlay canvas/layer container;
- fallback still frame is requested only when native preview is unavailable.

- [ ] **Step 3: Run tests to verify RED**

Run: `cd v2; npm test -- --run src/components/timeline src/components/Preview.test.tsx`

Expected: FAIL because timeline/preview do not exist.

- [ ] **Step 4: Implement the timeline and preview**

Use DOM/CSS transforms, pointer capture, and simple visible-range rendering; do not add a generic timeline framework. Filmstrip images are low-resolution assets generated after local media exists. Before download, use YouTube poster/metadata only. Preview overlays are ordinary React layers and never render video. Add `tauri-plugin-fs = "2"` and `tauri-plugin-persisted-scope = { version = "2", features = ["protocol-asset"] }`, register filesystem before persisted scope, and persist asset permission only for files/folders explicitly chosen by the user; never configure a blanket home-drive asset scope.

- [ ] **Step 5: Run tests/build**

Run:

```powershell
cd v2
npm test -- --run src/components/timeline src/components/Preview.test.tsx
npm run build
```

Expected: PASS and build exits 0.

- [ ] **Step 6: Commit**

```powershell
git add v2/src/components v2/src/app/EditorWorkspace.tsx v2/src/styles.css v2/src-tauri/Cargo.toml v2/src-tauri/src/lib.rs v2/src-tauri/tauri.conf.json v2/src-tauri/capabilities/main-window.json
git commit -m "feat: add source-time editor timeline"
```

---

### Task 8: Silence analysis and review without rendering

**Files:**
- Create: `v2/src-tauri/src/media/silence.rs`
- Create: `v2/src-tauri/src/commands/analysis.rs`
- Create: `v2/src-tauri/tests/silence_analysis.rs`
- Modify: `v2/src-tauri/src/media/mod.rs`
- Modify: `v2/src-tauri/src/commands/mod.rs`
- Create: `v2/src/features/silence/SilenceStep.tsx`
- Create: `v2/src/features/silence/SilenceStep.test.tsx`
- Modify: `v2/src/lib/backend.ts`
- Modify: `v2/src/components/timeline/Timeline.tsx`

**Interfaces:**
- Consumes: `JobManager`, `TimeRange`, source metadata, editor reducer.
- Produces:
  - `analyze_silence(request: AnalyzeSilenceRequest) -> Result<SilenceAnalysis, AppError>` using `silencedetect=noise=-35dB:d=0.6` and `0.2s` cut margin rules from v1.
  - `SilenceAnalysis { detected_regions: Vec<TimeRange>, waveform_image: Option<PathBuf> }`.
  - UI actions to accept/keep/split/merge detected ranges without rerunning FFmpeg.

- [ ] **Step 1: Write failing Rust analysis/parser tests**

Assert detection parser handles start/end pairs, trailing silence, no silence, and timestamp offsets. For `has_audio = false`, return a typed unsupported/no-audio result without starting FFmpeg. Verify waveform generation is an image analysis artifact, not a video encode.

- [ ] **Step 2: Write failing UI tests**

Assert accepted regions are separate from detected regions; toggling, splitting, merging, and disabling silence removal mutate only ProjectState and never call `analyze_silence` again unless the user explicitly re-runs analysis.

- [ ] **Step 3: Run tests to verify RED**

Run:

```powershell
cargo test --manifest-path v2/src-tauri/Cargo.toml --test silence_analysis
cd v2; npm test -- --run src/features/silence
```

Expected: FAIL.

- [ ] **Step 4: Implement analysis and review UI**

Use one FFmpeg analysis invocation that splits the selected audio: one branch runs `silencedetect`, the other produces one low-resolution `showwavespic` PNG. Emit progress through Task 4. Timeline renders detected and accepted cut regions distinctly.

- [ ] **Step 5: Run tests to verify GREEN**

Run the commands from Step 3.

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add v2/src-tauri/src/media/silence.rs v2/src-tauri/src/media/mod.rs v2/src-tauri/src/commands/analysis.rs v2/src-tauri/src/commands/mod.rs v2/src-tauri/tests/silence_analysis.rs v2/src/features/silence v2/src/lib/backend.ts v2/src/components/timeline/Timeline.tsx
git commit -m "feat: add non-destructive silence review"
```

---

### Task 9: Overlay and caption editing with live preview

**Files:**
- Create: `v2/src/features/design/DesignStep.tsx`
- Create: `v2/src/features/design/DesignStep.test.tsx`
- Create: `v2/src/features/design/overlayGeometry.ts`
- Create: `v2/src/features/design/overlayGeometry.test.ts`
- Create: `v2/src/features/captions/CaptionsStep.tsx`
- Create: `v2/src/features/captions/CaptionsStep.test.tsx`
- Create: `v2/src-tauri/src/media/captions.rs`
- Create: `v2/src-tauri/src/commands/captions.rs`
- Create: `v2/src-tauri/tests/captions.rs`
- Modify: `v2/src-tauri/src/media/mod.rs`
- Modify: `v2/src-tauri/src/commands/mod.rs`
- Modify: `v2/src/components/Preview.tsx`
- Modify: `v2/src/components/timeline/Timeline.tsx`
- Modify: `v2/src/lib/backend.ts`

**Interfaces:**
- Consumes: `Overlay`, `CaptionTrack`, source-time spans, timeline/playhead state.
- Produces:
  - `clampGeometry(geometry: NormalizedGeometry, aspectRatio?: number): NormalizedGeometry` for `[0,1]` coordinates.
  - image/logo and black-bar editing with source-time visibility spans.
  - Rust caption parsers `parse_srt`, `parse_ass`, and YouTube caption conversion into canonical `CaptionCue { start, end, text }`.
  - `import_captions(path: PathBuf) -> Result<CaptionTrack, AppError>` and `youtube_captions(url: String) -> Result<CaptionTrack, AppError>`; the YouTube path uses subtitles-only yt-dlp behavior and never downloads video.
  - caption style model shared by React preview and generated ASS export data with v1-compatible fields/defaults: `size_percent=4.5`, white text, black outline, `outline_width=1.2`, `shadow=2.0`, black shadow, background disabled/black/55% opacity, bottom/center position, `margin_percent=7.0`, `bold=false`, `italic=false`, plus an optional user-selected `font_path`.

- [ ] **Step 1: Write failing overlay geometry tests**

Assert drag/resize clamps inside normalized canvas bounds, aspect lock preserves image ratio, and preview-size changes do not change stored normalized geometry.

- [ ] **Step 2: Write failing caption parser tests**

Assert SRT and ASS timestamps parse to integer microseconds, multiline cues survive, malformed cues return typed errors, source-time cues remain source-time before RenderPlan compilation, and YouTube caption args include subtitles-only/skip-download behavior with Arabic language preference and no video output template.

- [ ] **Step 3: Write failing UI behavior tests**

Assert moving/resizing an overlay and changing caption style update the preview immediately without media-processing backend calls; caption cue click seeks the playhead; overlay/caption lanes display source-time spans; safe-area/alignment guides appear during manipulation; opacity and aspect lock update project state; selecting a local caption font only grants scope to that chosen file and never bundles it into app resources.

- [ ] **Step 4: Run tests to verify RED**

Run:

```powershell
cargo test --manifest-path v2/src-tauri/Cargo.toml --test captions
cd v2; npm test -- --run src/features/design src/features/captions
```

Expected: FAIL.

- [ ] **Step 5: Implement minimal overlay/caption editors**

Support only initial-scope `Image` and `BlackBar` overlays. Caption UI supports enable/disable, import, YouTube captions when available, editable style, cue lane, and live preview. Do not add generic text/effects/plugin infrastructure.

- [ ] **Step 6: Run tests to verify GREEN**

Run the commands from Step 4 plus `cd v2; npm run build`.

Expected: PASS and build exits 0.

- [ ] **Step 7: Commit**

```powershell
git add v2/src/features v2/src/components/Preview.tsx v2/src/components/timeline/Timeline.tsx v2/src/lib/backend.ts v2/src-tauri/src/media/captions.rs v2/src-tauri/src/media/mod.rs v2/src-tauri/src/commands/captions.rs v2/src-tauri/src/commands/mod.rs v2/src-tauri/tests/captions.rs
git commit -m "feat: add live overlay and caption editing"
```

---

### Task 10: One-render FFmpeg export, adaptive encoder, safe publication

**Files:**
- Create: `v2/src-tauri/src/media/ffmpeg.rs`
- Create: `v2/src-tauri/src/media/encoder.rs`
- Create: `v2/src-tauri/src/media/export.rs`
- Create: `v2/src-tauri/src/commands/export.rs`
- Create: `v2/src-tauri/tests/export_pipeline.rs`
- Create: `v2/src/features/export/ExportStep.tsx`
- Create: `v2/src/features/export/ExportStep.test.tsx`
- Modify: `v2/src/lib/backend.ts`
- Modify: `v2/src-tauri/src/commands/mod.rs`
- Modify: `v2/src-tauri/src/media/mod.rs`

**Interfaces:**
- Consumes: `RenderPlan` from Task 3, `JobManager` from Task 4, caption/overlay models from Task 9.
- Produces:
  - `EncoderCapabilities { qsv_h264: bool }`.
  - `choose_encoder(capabilities: &EncoderCapabilities, width: u32, height: u32, prefer_hardware: bool) -> EncoderSelection` using `width * height >= 1280 * 720` for QSV eligibility.
  - `prepare_render_assets(plan: &RenderPlan, job_dir: &Path) -> Result<PreparedRender, AppError>`.
  - `build_filter_graph(plan: &RenderPlan, prepared: &PreparedRender) -> Result<String, AppError>`.
  - `build_ffmpeg_args(plan: &RenderPlan, prepared: &PreparedRender, filter_file: &Path, temp_output: &Path) -> Vec<OsString>` using `-/filter_complex`.
  - `parse_ffmpeg_progress(fields: &BTreeMap<String, String>, duration: MediaTime) -> JobProgress`.
  - `export_project(request: ExportProjectRequest) -> Result<JobId, AppError>`.
  - final publication reuses Task 2 `atomic_replace_file` rather than implementing a second replace strategy.

- [ ] **Step 1: Write failing encoder/graph tests**

Assert:

- `1279x720` below pixel threshold selects CPU, `1280x720` selects QSV when available, and unavailable QSV selects CPU;
- multiple keep segments become one concat graph and one output encoder invocation;
- overlays and captions are appended to that same video graph after timeline reconstruction;
- no-audio input builds a valid video-only graph and does not reference `[0:a]`;
- generated args contain exactly one encoded final output and no intermediate video path;
- graph is passed by `-/filter_complex <file>`;
- Unicode/space-heavy input/output paths remain discrete `OsString` arguments.
- FFmpeg `-progress` fields produce bounded percent, speed, and ETA telemetry without treating missing optional fields as failure.

- [ ] **Step 2: Write failing safe-publication tests**

Use a temp destination containing a valid pre-existing file. Assert:

- failed export leaves the old destination unchanged;
- cancellation after FFmpeg exits but before publication cannot replace the old destination;
- success validates temp output then atomically replaces/publishes destination;
- job-owned temp output is removed on failure/cancel.

- [ ] **Step 3: Write failing real FFmpeg integration test**

Generate a tiny synthetic A/V fixture plus PNG and caption cue, compile a plan with one silence cut, overlay, and captions, run the real installed FFmpeg once, then ffprobe output. Assert expected duration, H.264 video, audio presence when input has audio, dimensions, and near-zero normalized stream starts.

- [ ] **Step 4: Write failing Export UI test**

Assert summary shows range/cuts/overlays/captions/resolution/encoder/output path, the primary button says `تصدير الفيديو النهائي`, and clicking it sends one structured `export_project` request. UI must state in Arabic that all selected edits are applied in one final render.

- [ ] **Step 5: Run tests to verify RED**

Run:

```powershell
cargo test --manifest-path v2/src-tauri/Cargo.toml --test export_pipeline
cd v2; npm test -- --run src/features/export
```

Expected: FAIL.

- [ ] **Step 6: Implement export executor and fallback**

Build one graph from the immutable RenderPlan, generate output-time ASS into the job directory, prepare static overlay assets once, run FFmpeg with `-progress pipe:1 -nostats`, stream structured progress, and publish only after successful validation and cancellation re-check through Task 2 `atomic_replace_file`. If QSV initialization fails before useful output, retry once with CPU using the same RenderPlan; do not create a multi-stage encode chain.

- [ ] **Step 7: Run tests to verify GREEN**

Run the commands from Step 5.

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add v2/src-tauri/src/media v2/src-tauri/src/commands/export.rs v2/src-tauri/tests/export_pipeline.rs v2/src/features/export v2/src/lib/backend.ts
git commit -m "feat: add single-pass final export"
```

---

### Task 11: Autosave/recovery, structured errors, RTL, keyboard workflow, and operation cockpit

**Files:**
- Create: `v2/src/app/autosave.ts`
- Create: `v2/src/app/autosave.test.ts`
- Create: `v2/src/components/OperationCockpit.tsx`
- Create: `v2/src/components/OperationCockpit.test.tsx`
- Create: `v2/src/components/ErrorNotice.tsx`
- Create: `v2/src/components/ErrorNotice.test.tsx`
- Create: `v2/src-tauri/src/commands/project.rs`
- Create: `v2/src-tauri/tests/project_recovery.rs`
- Modify: `v2/src-tauri/src/commands/mod.rs`
- Modify: `v2/src-tauri/src/lib.rs`
- Modify: `v2/src/app/EditorWorkspace.tsx`
- Modify: `v2/src/lib/backend.ts`
- Modify: `v2/src/styles.css`

**Interfaces:**
- Consumes: project persistence from Task 2, JobManager progress/cancel from Task 4, EditorState from Task 6.
- Produces:
  - debounced 750ms recovery autosave for project edits.
  - explicit project save/load commands.
  - operation cockpit for stage/progress/speed/ETA/message and `Stop Operation`.
  - structured user-facing error surface with expandable technical details.

- [ ] **Step 1: Write failing autosave/recovery tests**

Assert project edits coalesce into one save after 750ms, playhead-only changes do not autosave, a missing source on reopened project yields `SourceUnavailable` UI while keeping project edits intact, and autosave failure does not replace the last valid project copy.

- [ ] **Step 2: Write failing cockpit/error tests**

Assert running jobs enable `Stop Operation`, idle/completed jobs disable it, cancel requests render `Cancelling` then `Cancelled`, stale success after cancellation is ignored, primary errors are concise, technical stderr is hidden until expanded.

- [ ] **Step 3: Add keyboard/RTL accessibility tests**

Assert step controls and primary editor actions are keyboard reachable; `I`, `O`, frame-step, undo/redo, and play/pause shortcuts do not fire while typing in timestamp/text inputs; timestamp fields use LTR while the editor chrome remains RTL-capable; icon-only controls have accessible names.

- [ ] **Step 4: Run tests to verify RED**

Run:

```powershell
cargo test --manifest-path v2/src-tauri/Cargo.toml --test project_recovery
cd v2; npm test -- --run src/app/autosave.test.ts src/components/OperationCockpit.test.tsx src/components/ErrorNotice.test.tsx
```

Expected: FAIL.

- [ ] **Step 5: Implement durability and polish**

Keep the frontend simple: one error component, one cockpit, one autosave helper. Do not add a generic notification framework or global event bus.

- [ ] **Step 6: Run frontend/Rust suites**

Run:

```powershell
cargo test --manifest-path v2/src-tauri/Cargo.toml
cd v2; npm test -- --run
npm run build
```

Expected: all tests PASS and build exits 0.

- [ ] **Step 7: Commit**

```powershell
git add v2
git commit -m "feat: harden v2 editor workflow"
```

---

### Task 12: Windows end-to-end smoke, packaging, and v1 parity evidence

**Files:**
- Create: `v2/scripts/smoke-local.ps1`
- Create: `v2/scripts/smoke-youtube.ps1`
- Create: `v2/README.md`
- Create: `docs/superpowers/v2-cutover-checklist.md`
- Modify: root `README.md`

**Interfaces:**
- Consumes: complete v2 application from Tasks 1-11 and existing v1 behavior/performance evidence.
- Produces: repeatable Windows smoke scripts, packaged debug/release build, and explicit cutover evidence. Does not delete v1 or change latest release yet.

- [ ] **Step 1: Write smoke scripts before declaring readiness**

`smoke-local.ps1` must generate/use a tiny fixture and verify the end-to-end backend path: probe -> selection -> silence decision -> overlay -> captions -> one export -> ffprobe assertions -> cleanup.

`smoke-youtube.ps1` accepts a URL parameter, performs metadata-only inspection first, then downloads only a short selected range, and verifies no full-video artifact is created. Keep this network smoke opt-in rather than part of every unit-test run.

- [ ] **Step 2: Run complete automated verification**

Run:

```powershell
cargo test --manifest-path v2/src-tauri/Cargo.toml
cd v2
npm test -- --run
npm run build
npm run stage:sidecars
npm run tauri -- build --debug
```

Expected: every test PASS; frontend build exits 0; sidecars staged; Tauri debug package/build exits 0.

- [ ] **Step 3: Run local end-to-end smoke**

Run: `powershell -ExecutionPolicy Bypass -File v2\scripts\smoke-local.ps1`

Expected: PASS with exactly one FFmpeg encode process for final export, valid MP4 output, correct duration within fixture tolerance, and no owned temp files left behind.

- [ ] **Step 4: Run GUI acceptance smoke on the real app**

Verify at minimum:

- Source -> Range -> skip Silence -> Design -> Captions -> Export works without confusing intermediate files.
- full source timeline remains visible with selected range highlighted.
- dragging playhead/overlays and changing caption styles causes no FFmpeg process.
- Stop Operation cancels a real export without closing the app or replacing an existing output.
- RTL labels/layout and LTR timestamp entry are usable at the target window size.

- [ ] **Step 5: Run opt-in real YouTube partial smoke**

Run `smoke-youtube.ps1 -Url <known-good-public-test-url> -Start <short-start> -End <short-end>` using a stable public test source selected at execution time.

Expected: metadata is visible before media download; only the selected section is downloaded; downloaded section is usable by v2; no full source video is present.

- [ ] **Step 6: Record parity/performance evidence**

Fill `docs/superpowers/v2-cutover-checklist.md` with fresh results for all spec cutover items. Compare representative 360p, 720p, and 1080p final exports against the existing v1 baseline on the Intel Core Ultra 5 125H / Intel Arc machine. A failed cutover item blocks replacing v1 but does not invalidate a usable v2 preview build.

- [ ] **Step 7: Commit**

```powershell
git add v2/scripts v2/README.md docs/superpowers/v2-cutover-checklist.md README.md
git commit -m "test: verify v2 windows workflow"
```

---

## Final implementation verification

Before any claim that v2 is complete or ready to replace v1:

1. run the full Rust suite;
2. run the full frontend suite;
3. run the frontend production build;
4. stage real sidecars and run a Tauri build;
5. run local end-to-end smoke;
6. run the real GUI acceptance smoke;
7. run the opt-in YouTube partial smoke when network access is available;
8. inspect `git diff --check` and the final diff;
9. request a fresh whole-branch code review focused on the five Review Focus items and the one-render invariant;
10. fix all Critical/Important findings with RED->GREEN tests;
11. use `superpowers:finishing-a-development-branch` before integration/push/release decisions.

Do not delete Python v1, retag releases, or publish v2 as latest until the cutover checklist is fully green.
