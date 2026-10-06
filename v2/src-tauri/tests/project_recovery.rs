use std::{fs, path::PathBuf};

use mini_video_tool_v2::{
    commands::project::{SourceAvailability, load_project_result},
    domain::{
        project::{
            CaptionStyle, CaptionTrack, DownloadQuality, ExportSettings, PROJECT_SCHEMA_VERSION,
            Project, SilenceState, SourceMetadata, SourceState,
        },
        time::{FrameRate, MediaTime, TimeRange},
    },
    project_io::{load_project, save_project_atomic},
};

fn sample_project(source: PathBuf) -> Project {
    Project {
        schema_version: PROJECT_SCHEMA_VERSION,
        source: SourceState {
            path: Some(source),
            metadata: Some(SourceMetadata {
                duration: MediaTime(20_000_000),
                width: 1280,
                height: 720,
                frame_rate: FrameRate {
                    numerator: 30,
                    denominator: 1,
                },
                has_audio: true,
            }),
            url: None,
            youtube_metadata: None,
            resolved_path: None,
            source_offset: None,
            resolved_metadata: None,
            download_quality: DownloadQuality::Best,
        },
        selection: Some(TimeRange::new(2_000_000, 18_000_000).unwrap()),
        silence: SilenceState::default(),
        overlays: vec![],
        captions: CaptionTrack {
            enabled: false,
            cues: vec![],
            style: CaptionStyle::default(),
        },
        export: ExportSettings {
            width: 1280,
            height: 720,
            frame_rate: FrameRate {
                numerator: 30,
                denominator: 1,
            },
        },
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "mvt-recovery-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn reopening_missing_local_source_keeps_project_edits_and_reports_source_unavailable() {
    let root = temp_dir("missing-source");
    let missing = root.join("missing video.mp4");
    let path = root.join("recovery.mvt");
    let project = sample_project(missing.clone());
    save_project_atomic(&path, &project).unwrap();

    let loaded = load_project_result(&path).unwrap();
    assert_eq!(loaded.project.selection, project.selection);
    assert_eq!(loaded.project.captions, project.captions);
    assert!(matches!(
        loaded.source_availability,
        SourceAvailability::Unavailable { .. }
    ));
    assert_eq!(
        loaded.project.source.path.as_deref(),
        Some(missing.as_path())
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_autosave_never_replaces_the_last_valid_project_copy() {
    let root = temp_dir("failed-save");
    let path = root.join("recovery.mvt");
    let mut valid = sample_project(root.join("source.mp4"));
    save_project_atomic(&path, &valid).unwrap();
    valid.schema_version = 99;
    assert!(save_project_atomic(&path, &valid).is_err());

    let reloaded = load_project(&path).unwrap();
    assert_eq!(reloaded.schema_version, PROJECT_SCHEMA_VERSION);
    assert_eq!(reloaded.selection, valid.selection);
    let _ = fs::remove_dir_all(root);
}
