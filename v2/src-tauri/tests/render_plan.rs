use std::path::PathBuf;

use mini_video_tool_v2::domain::{
    project::{
        CaptionCue, CaptionStyle, CaptionTrack, DownloadQuality, ExportSettings, NormalizedRect,
        Overlay, PROJECT_SCHEMA_VERSION, Project, SilenceState, SourceMetadata, SourceState,
    },
    render_plan::{
        EncoderSelection, ResolvedInput, build_keep_segments, compile_render_plan, map_source_time,
    },
    time::{FrameRate, MediaTime, TimeRange},
};

const SECOND: i64 = 1_000_000;

fn range(start_seconds: i64, end_seconds: i64) -> TimeRange {
    TimeRange::new(start_seconds * SECOND, end_seconds * SECOND).expect("valid test range")
}

fn metadata() -> SourceMetadata {
    SourceMetadata {
        duration: MediaTime(40 * SECOND),
        width: 1920,
        height: 1080,
        frame_rate: FrameRate {
            numerator: 30,
            denominator: 1,
        },
        has_audio: true,
    }
}

fn project(cues: Vec<CaptionCue>, overlays: Vec<Overlay>) -> Project {
    Project {
        schema_version: PROJECT_SCHEMA_VERSION,
        source: SourceState {
            path: Some(PathBuf::from(r"C:\media\source.mp4")),
            metadata: Some(metadata()),
            download_quality: DownloadQuality::Best,
        },
        selection: Some(range(10, 30)),
        silence: SilenceState {
            detected_regions: Vec::new(),
            accepted_removed_regions: vec![range(15, 17)],
        },
        overlays,
        captions: CaptionTrack {
            enabled: true,
            cues,
            style: CaptionStyle::default(),
        },
        export: ExportSettings {
            width: 1920,
            height: 1080,
            frame_rate: FrameRate {
                numerator: 30,
                denominator: 1,
            },
        },
    }
}

fn resolved_input(source_offset_seconds: i64) -> ResolvedInput {
    ResolvedInput {
        path: PathBuf::from(r"C:\cache\download.mp4"),
        source_offset: MediaTime(source_offset_seconds * SECOND),
        metadata: metadata(),
    }
}

#[test]
fn selection_minus_removed_ranges_builds_expected_keep_segments_and_duration() {
    let keep = build_keep_segments(range(10, 30), &[range(15, 17)]).expect("build keep segments");
    assert_eq!(keep, vec![range(10, 15), range(17, 30)]);

    let plan = compile_render_plan(
        &project(Vec::new(), Vec::new()),
        resolved_input(0),
        PathBuf::from(r"C:\exports\final.mp4"),
        EncoderSelection::CpuX264,
    )
    .expect("compile render plan");

    assert_eq!(plan.keep_segments(), keep.as_slice());
    assert_eq!(plan.duration(), MediaTime(18 * SECOND));
}

#[test]
fn overlapping_and_adjacent_removals_normalize_before_subtraction() {
    let removed = [range(14, 16), range(15, 18), range(18, 20)];
    let keep = build_keep_segments(range(10, 30), &removed).expect("build keep segments");

    assert_eq!(keep, vec![range(10, 14), range(20, 30)]);
}

#[test]
fn caption_source_time_maps_to_output_time_after_cut() {
    let cue = CaptionCue {
        start: MediaTime(18 * SECOND),
        end: MediaTime(20 * SECOND),
        text: "hello".into(),
    };
    let keep = build_keep_segments(range(10, 30), &[range(15, 17)]).expect("build keep segments");

    assert_eq!(
        map_source_time(&keep, MediaTime(18 * SECOND)),
        Some(MediaTime(6 * SECOND))
    );

    let plan = compile_render_plan(
        &project(vec![cue], Vec::new()),
        resolved_input(0),
        PathBuf::from(r"C:\exports\final.mp4"),
        EncoderSelection::CpuX264,
    )
    .expect("compile render plan");

    assert_eq!(plan.captions().len(), 1);
    assert_eq!(plan.captions()[0].start, MediaTime(6 * SECOND));
    assert_eq!(plan.captions()[0].end, MediaTime(8 * SECOND));
    assert_eq!(plan.captions()[0].text, "hello");
}

#[test]
fn overlay_crossing_removed_boundary_is_split_into_valid_output_spans() {
    let overlay = Overlay {
        id: "logo".into(),
        kind: Default::default(),
        range: range(14, 18),
        geometry: NormalizedRect {
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.2,
        },
        opacity: 1.0,
        asset_path: None,
        aspect_locked: false,
    };

    let plan = compile_render_plan(
        &project(Vec::new(), vec![overlay]),
        resolved_input(0),
        PathBuf::from(r"C:\exports\final.mp4"),
        EncoderSelection::CpuX264,
    )
    .expect("compile render plan");

    assert_eq!(plan.overlays().len(), 1);
    assert_eq!(
        plan.overlays()[0].spans,
        vec![
            TimeRange::new(4 * SECOND, 5 * SECOND).unwrap(),
            TimeRange::new(5 * SECOND, 6 * SECOND).unwrap()
        ]
    );
    assert!(
        plan.overlays()[0]
            .spans
            .iter()
            .all(|span| span.start().0 >= 0 && span.end().0 > span.start().0)
    );
}

#[test]
fn edits_completely_outside_selection_do_not_enter_plan() {
    let cue = CaptionCue {
        start: MediaTime(31 * SECOND),
        end: MediaTime(32 * SECOND),
        text: "outside".into(),
    };
    let overlay = Overlay {
        id: "outside".into(),
        kind: Default::default(),
        range: range(1, 5),
        geometry: NormalizedRect {
            x: 0.0,
            y: 0.0,
            width: 0.5,
            height: 0.5,
        },
        opacity: 1.0,
        asset_path: None,
        aspect_locked: false,
    };

    let plan = compile_render_plan(
        &project(vec![cue], vec![overlay]),
        resolved_input(0),
        PathBuf::from(r"C:\exports\final.mp4"),
        EncoderSelection::IntelQsv,
    )
    .expect("compile render plan");

    assert!(plan.captions().is_empty());
    assert!(plan.overlays().is_empty());
}

#[test]
fn source_offset_preroll_does_not_change_source_time_decisions() {
    let cue = CaptionCue {
        start: MediaTime(18 * SECOND),
        end: MediaTime(20 * SECOND),
        text: "same".into(),
    };
    let overlay = Overlay {
        id: "logo".into(),
        kind: Default::default(),
        range: range(14, 18),
        geometry: NormalizedRect {
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.2,
        },
        opacity: 1.0,
        asset_path: None,
        aspect_locked: false,
    };
    let project = project(vec![cue], vec![overlay]);
    let output = PathBuf::from(r"C:\exports\final.mp4");

    let no_preroll = compile_render_plan(
        &project,
        resolved_input(0),
        output.clone(),
        EncoderSelection::CpuX264,
    )
    .expect("compile without preroll");
    let with_preroll = compile_render_plan(
        &project,
        resolved_input(8),
        output,
        EncoderSelection::CpuX264,
    )
    .expect("compile with preroll");

    assert_eq!(with_preroll.keep_segments(), no_preroll.keep_segments());
    assert_eq!(with_preroll.duration(), no_preroll.duration());
    assert_eq!(with_preroll.captions(), no_preroll.captions());
    assert_eq!(with_preroll.overlays(), no_preroll.overlays());
    assert_eq!(with_preroll.input().source_offset, MediaTime(8 * SECOND));
}
