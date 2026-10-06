use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use mini_video_tool_v2::{
    domain::{
        project::{
            CaptionStyle, CaptionTrack, DownloadQuality, ExportSettings, NormalizedRect, Overlay,
            PROJECT_SCHEMA_VERSION, Project, SilenceState, SourceMetadata, SourceState,
        },
        time::{FrameRate, MediaTime, TimeRange, frame_step},
    },
    project_io::{atomic_replace_file, load_project, save_project_atomic},
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn test_dir(label: &str) -> PathBuf {
    let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "mini-video-tool-v2-{label}-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create test directory");
    path
}

fn sample_project(source_path: PathBuf) -> Project {
    Project {
        schema_version: PROJECT_SCHEMA_VERSION,
        source: SourceState {
            path: Some(source_path),
            metadata: Some(SourceMetadata {
                duration: MediaTime(60_000_000),
                width: 1920,
                height: 1080,
                frame_rate: FrameRate {
                    numerator: 30_000,
                    denominator: 1_001,
                },
                has_audio: true,
            }),
            download_quality: DownloadQuality::P1080,
        },
        selection: Some(TimeRange::new(10_000_000, 30_000_000).expect("valid selection")),
        silence: SilenceState {
            detected_regions: vec![
                TimeRange::new(12_000_000, 13_000_000).expect("valid detected silence"),
            ],
            accepted_removed_regions: vec![
                TimeRange::new(20_000_000, 21_000_000).expect("valid removed silence"),
            ],
        },
        overlays: vec![Overlay {
            id: "logo".into(),
            range: TimeRange::new(10_000_000, 30_000_000).expect("valid overlay range"),
            geometry: NormalizedRect {
                x: 0.05,
                y: 0.05,
                width: 0.2,
                height: 0.2,
            },
        }],
        captions: CaptionTrack {
            enabled: true,
            cues: Vec::new(),
            style: CaptionStyle {
                font_family: Some("Arial".into()),
                font_size_px: Some(48),
            },
        },
        export: ExportSettings {
            width: 1920,
            height: 1080,
            frame_rate: FrameRate {
                numerator: 30_000,
                denominator: 1_001,
            },
        },
    }
}

#[test]
fn time_range_requires_positive_duration() {
    let range = TimeRange::new(10_000_000, 30_000_000).expect("valid range");
    assert_eq!(range.start(), MediaTime(10_000_000));
    assert_eq!(range.end(), MediaTime(30_000_000));
    assert!(TimeRange::new(10_000_000, 10_000_000).is_err());
    assert!(TimeRange::new(30_000_000, 10_000_000).is_err());
}

#[test]
fn frame_step_uses_integer_rational_arithmetic() {
    let rate = FrameRate {
        numerator: 30_000,
        denominator: 1_001,
    };

    assert_eq!(
        frame_step(MediaTime(0), 30, rate).expect("step 30 frames"),
        MediaTime(1_001_000)
    );
    assert_eq!(
        frame_step(MediaTime(5_000_000), 30_000, rate).expect("large exact frame step"),
        MediaTime(1_006_000_000)
    );
    let mut repeated = MediaTime(0);
    for _ in 0..1_000 {
        repeated = frame_step(repeated, 30, rate).expect("repeat exact rational frame step");
    }
    assert_eq!(repeated, MediaTime(1_001_000_000));
}

#[test]
fn repeated_single_frame_steps_stay_on_grid_and_reverse_cleanly() {
    let rate = FrameRate {
        numerator: 30_000,
        denominator: 1_001,
    };

    let mut time = MediaTime(0);
    for _ in 0..30 {
        time = frame_step(time, 1, rate).expect("step forward one frame");
    }
    assert_eq!(time, MediaTime(1_001_000));

    for _ in 0..30 {
        time = frame_step(time, -1, rate).expect("step backward one frame");
    }
    assert_eq!(time, MediaTime(0));

    assert_eq!(
        frame_step(MediaTime(123_456), 0, rate).expect("zero frames"),
        MediaTime(123_456)
    );
}

#[test]
fn project_json_round_trips_schema_version_one() {
    let project = sample_project(PathBuf::from(r"C:\media\source.mp4"));
    let json = serde_json::to_value(&project).expect("serialize project");

    assert_eq!(json["schemaVersion"], 1);
    assert!(json.get("schema_version").is_none());

    let decoded: Project = serde_json::from_value(json).expect("deserialize project");
    assert_eq!(decoded, project);
}

#[test]
fn malformed_time_range_json_is_rejected() {
    assert!(serde_json::from_str::<TimeRange>(r#"{"start":100,"end":100}"#).is_err());
    assert!(serde_json::from_str::<TimeRange>(r#"{"start":200,"end":100}"#).is_err());

    let range = serde_json::from_str::<TimeRange>(r#"{"start":100,"end":200}"#)
        .expect("valid time range json");
    assert_eq!(range, TimeRange::new(100, 200).expect("valid range"));
    assert_eq!(range.start(), MediaTime(100));
    assert_eq!(range.end(), MediaTime(200));
}

#[test]
fn load_rejects_unsupported_project_schema_version() {
    let dir = test_dir("unsupported-load-schema");
    let project_path = dir.join("project.mvt.json");
    let project = sample_project(PathBuf::from(r"C:\media\source.mp4"));
    let mut json = serde_json::to_value(project).expect("serialize project");
    json["schemaVersion"] = serde_json::json!(2);
    fs::write(
        &project_path,
        serde_json::to_vec_pretty(&json).expect("serialize unsupported project json"),
    )
    .expect("write unsupported project");

    assert!(load_project(&project_path).is_err());

    fs::remove_dir_all(dir).expect("remove test directory");
}

#[test]
fn save_rejects_unsupported_project_schema_version() {
    let dir = test_dir("unsupported-save-schema");
    let project_path = dir.join("project.mvt.json");
    let mut project = sample_project(PathBuf::from(r"C:\media\source.mp4"));
    project.schema_version = 2;

    assert!(save_project_atomic(&project_path, &project).is_err());
    assert!(!project_path.exists());

    fs::remove_dir_all(dir).expect("remove test directory");
}

#[test]
fn atomic_replace_keeps_destination_until_temp_is_ready() {
    let dir = test_dir("atomic-replace");
    let destination = dir.join("project.mvt.json");
    let temp = dir.join("project.mvt.json.tmp");
    fs::write(&destination, b"old project").expect("write destination");

    let mut temp_file = File::create(&temp).expect("create temp file");
    temp_file.write_all(b"new ").expect("write partial temp");
    assert_eq!(
        fs::read(&destination).expect("read old destination"),
        b"old project"
    );
    temp_file
        .write_all(b"project")
        .expect("finish temp file before replacement");
    temp_file.flush().expect("flush temp file");
    temp_file.sync_all().expect("sync temp file");
    drop(temp_file);

    atomic_replace_file(&temp, &destination).expect("atomically replace destination");
    assert_eq!(
        fs::read(&destination).expect("read replaced destination"),
        b"new project"
    );
    assert!(!temp.exists());

    fs::remove_dir_all(dir).expect("remove test directory");
}

#[test]
fn atomic_project_save_replaces_existing_project_with_complete_json() {
    let dir = test_dir("atomic-save");
    let project_path = dir.join("project.mvt.json");
    let mut first = sample_project(PathBuf::from(r"C:\media\first.mp4"));
    let mut second = sample_project(PathBuf::from(r"C:\media\second.mp4"));
    first.selection = None;
    second.selection = Some(TimeRange::new(2_000_000, 8_000_000).expect("valid selection"));

    save_project_atomic(&project_path, &first).expect("save first project");
    save_project_atomic(&project_path, &second).expect("replace with second project");

    assert_eq!(
        load_project(&project_path).expect("load replaced project"),
        second
    );

    fs::remove_dir_all(dir).expect("remove test directory");
}

#[test]
fn load_project_preserves_missing_source_path() {
    let dir = test_dir("missing-source");
    let project_path = dir.join("project.mvt.json");
    let missing_source = dir.join("media-that-no-longer-exists.mp4");
    let project = sample_project(missing_source.clone());
    assert!(!missing_source.exists());

    save_project_atomic(&project_path, &project).expect("save project with missing source path");
    let loaded = load_project(&project_path).expect("missing media must not block project load");

    assert_eq!(loaded, project);
    assert_eq!(
        loaded.source.path.as_deref(),
        Some(missing_source.as_path())
    );

    fs::remove_dir_all(dir).expect("remove test directory");
}
