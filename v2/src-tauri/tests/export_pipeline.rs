use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use mini_video_tool_v2::{
    domain::{
        project::{
            CaptionCue, CaptionStyle, CaptionTrack, DownloadQuality, ExportSettings,
            NormalizedRect, Overlay, OverlayKind, PROJECT_SCHEMA_VERSION, Project, SilenceState,
            SourceMetadata, SourceState,
        },
        render_plan::{EncoderSelection, ResolvedInput, compile_render_plan},
        time::{FrameRate, MediaTime, TimeRange},
    },
    media::{
        encoder::{EncoderCapabilities, choose_encoder, is_qsv_initialization_failure},
        export::{
            build_ffmpeg_args, build_filter_graph, parse_ffmpeg_progress, prepare_render_assets,
            publish_temp_output,
        },
    },
};

const SECOND: i64 = 1_000_000;

fn range(start: i64, end: i64) -> TimeRange {
    TimeRange::new(start * SECOND, end * SECOND).unwrap()
}

fn metadata(has_audio: bool) -> SourceMetadata {
    SourceMetadata {
        duration: MediaTime(12 * SECOND),
        width: 1280,
        height: 720,
        frame_rate: FrameRate {
            numerator: 30_000,
            denominator: 1_001,
        },
        has_audio,
    }
}

fn project(has_audio: bool, image_path: Option<PathBuf>) -> Project {
    let mut overlays = vec![Overlay {
        id: "bar".into(),
        kind: OverlayKind::BlackBar,
        range: range(2, 9),
        geometry: NormalizedRect {
            x: 0.0,
            y: 0.8,
            width: 1.0,
            height: 0.2,
        },
        opacity: 0.7,
        asset_path: None,
        aspect_locked: false,
    }];
    if let Some(image_path) = image_path {
        overlays.push(Overlay {
            id: "logo".into(),
            kind: OverlayKind::Image,
            range: range(3, 10),
            geometry: NormalizedRect {
                x: 0.75,
                y: 0.05,
                width: 0.2,
                height: 0.2,
            },
            opacity: 0.8,
            asset_path: Some(image_path),
            aspect_locked: true,
        });
    }
    Project {
        schema_version: PROJECT_SCHEMA_VERSION,
        source: SourceState {
            path: Some(PathBuf::from(r"C:\فيديوهات فيها مسافات\مصدر.mp4")),
            metadata: Some(metadata(has_audio)),
            download_quality: DownloadQuality::Best,
        },
        selection: Some(range(1, 11)),
        silence: SilenceState {
            detected_regions: vec![],
            accepted_removed_regions: vec![range(5, 6)],
        },
        overlays,
        captions: CaptionTrack {
            enabled: true,
            cues: vec![CaptionCue {
                start: MediaTime(7 * SECOND),
                end: MediaTime(9 * SECOND),
                text: "سطر أول\nسطر ثان".into(),
            }],
            style: CaptionStyle::default(),
        },
        export: ExportSettings {
            width: 1280,
            height: 720,
            frame_rate: FrameRate {
                numerator: 30_000,
                denominator: 1_001,
            },
        },
    }
}

fn plan(
    has_audio: bool,
    image_path: Option<PathBuf>,
    source_offset: i64,
) -> mini_video_tool_v2::domain::render_plan::RenderPlan {
    let project = project(has_audio, image_path);
    compile_render_plan(
        &project,
        ResolvedInput {
            path: PathBuf::from(r"C:\فيديوهات فيها مسافات\مصدر.mp4"),
            source_offset: MediaTime(source_offset),
            metadata: metadata(has_audio),
        },
        PathBuf::from(r"C:\نتائج فيها مسافات\الفيديو النهائي.mp4"),
        EncoderSelection::CpuX264,
    )
    .unwrap()
}

fn temp_dir(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "mvt-export-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn encoder_policy_uses_qsv_only_at_or_above_hd_when_available() {
    let available = EncoderCapabilities { qsv_h264: true };
    let unavailable = EncoderCapabilities { qsv_h264: false };
    assert_eq!(
        choose_encoder(&available, 1279, 720, true),
        EncoderSelection::CpuX264
    );
    assert_eq!(
        choose_encoder(&available, 1280, 720, true),
        EncoderSelection::IntelQsv
    );
    assert_eq!(
        choose_encoder(&unavailable, 1920, 1080, true),
        EncoderSelection::CpuX264
    );
    assert_eq!(
        choose_encoder(&available, 1920, 1080, false),
        EncoderSelection::CpuX264
    );
}

#[test]
fn one_graph_reconstructs_keep_segments_then_applies_overlays_and_captions() {
    let root = temp_dir("graph");
    let image = root.join("شعار فيه مسافات.png");
    fs::write(&image, b"fake image bytes").unwrap();
    let render_plan = plan(true, Some(image), 500_000);
    let prepared = prepare_render_assets(&render_plan, &root).unwrap();
    let graph = build_filter_graph(&render_plan, &prepared).unwrap();

    assert!(graph.contains("concat=n=2:v=1:a=1"));
    assert_eq!(
        graph
            .matches("force_original_aspect_ratio=decrease")
            .count(),
        1
    );
    assert!(graph.contains("fps=30000/1001"));
    assert!(graph.contains("drawbox="));
    assert!(graph.contains("overlay="));
    assert!(graph.contains("ass="));
    assert!(graph.ends_with("[vout]"));
    // Source 1.0s begins at physical 0.5s because the local media has 0.5s preroll offset.
    assert!(graph.contains("trim=start=0.500000:end=4.500000"));
    assert_eq!(prepared.image_inputs().len(), 1);
    assert!(prepared.caption_ass().is_some());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn qsv_fallback_only_recognizes_hardware_initialization_failures() {
    assert!(is_qsv_initialization_failure(
        "[h264_qsv] Error initializing an internal MFX session: unsupported (-3)"
    ));
    assert!(is_qsv_initialization_failure(
        "h264_qsv: Error while opening encoder device"
    ));
    assert!(!is_qsv_initialization_failure(
        "No such file or directory: overlay.png"
    ));
    assert!(!is_qsv_initialization_failure(
        "Error initializing output stream 0:0"
    ));
}

#[test]
fn no_audio_graph_never_references_audio_input_or_audio_output() {
    let root = temp_dir("no-audio");
    let render_plan = plan(false, None, 0);
    let prepared = prepare_render_assets(&render_plan, &root).unwrap();
    let graph = build_filter_graph(&render_plan, &prepared).unwrap();
    assert!(!graph.contains("[0:a]"));
    assert!(!graph.contains("[aout]"));
    assert!(graph.contains("concat=n=2:v=1:a=0"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ffmpeg_args_use_filter_complex_file_and_only_one_encoded_video_output() {
    let root = temp_dir("args");
    let image = root.join("شعار فيه مسافات.png");
    fs::write(&image, b"fake image bytes").unwrap();
    let render_plan = plan(true, Some(image), 0);
    let prepared = prepare_render_assets(&render_plan, &root).unwrap();
    let filter_file = root.join("مخطط المعالجة.txt");
    let temp_output = root.join(".الفيديو النهائي.tmp.mp4");
    let args = build_ffmpeg_args(&render_plan, &prepared, &filter_file, &temp_output);

    let rendered = args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>();
    assert!(
        rendered
            .windows(2)
            .any(|pair| pair[0] == "-/filter_complex" && pair[1] == filter_file.to_string_lossy())
    );
    assert!(!rendered.iter().any(|arg| arg == "-filter_complex_script"));
    assert_eq!(rendered.iter().filter(|arg| **arg == "-c:v").count(), 1);
    assert_eq!(
        rendered
            .iter()
            .filter(|arg| **arg == temp_output.to_string_lossy())
            .count(),
        1
    );
    assert!(
        args.iter()
            .any(|arg| arg == &OsString::from(r"C:\فيديوهات فيها مسافات\مصدر.mp4"))
    );
    assert_eq!(rendered.last().unwrap(), &temp_output.to_string_lossy());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ffmpeg_progress_is_bounded_and_optional_telemetry_is_tolerated() {
    let mut fields = BTreeMap::new();
    fields.insert("out_time_us".into(), "12000000".into());
    fields.insert("speed".into(), "2.0x".into());
    let progress = parse_ffmpeg_progress(&fields, MediaTime(10 * SECOND));
    assert_eq!(progress.fraction, Some(1.0));
    assert_eq!(progress.speed.as_deref(), Some("2.0x"));
    assert_eq!(progress.eta_seconds, Some(0));

    let empty = parse_ffmpeg_progress(&BTreeMap::new(), MediaTime(10 * SECOND));
    assert_eq!(empty.fraction, None);
    assert_eq!(empty.speed, None);
    assert_eq!(empty.eta_seconds, None);

    let mut finished = BTreeMap::new();
    finished.insert("progress".into(), "end".into());
    let finished_progress = parse_ffmpeg_progress(&finished, MediaTime(10 * SECOND));
    assert_eq!(finished_progress.fraction, Some(1.0));
    assert_eq!(finished_progress.eta_seconds, Some(0));
}

#[test]
fn default_caption_asset_keeps_black_shadow_when_background_is_disabled() {
    let root = temp_dir("caption-shadow");
    let render_plan = plan(true, None, 0);
    let prepared = prepare_render_assets(&render_plan, &root).unwrap();
    let ass = fs::read_to_string(prepared.caption_ass().expect("caption ASS path")).unwrap();
    let style_line = ass
        .lines()
        .find(|line| line.starts_with("Style: Default,"))
        .unwrap();
    let fields = style_line.split(',').collect::<Vec<_>>();
    assert_eq!(
        fields[6], "&H00000000",
        "default BackColour must keep the configured black shadow opaque when no background box is enabled"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn publication_preserves_existing_destination_on_cancel_and_replaces_it_on_success() {
    let root = temp_dir("publish");
    let destination = root.join("final.mp4");
    let temp = root.join(".final.tmp.mp4");
    fs::write(&destination, b"old final").unwrap();
    fs::write(&temp, b"new final").unwrap();

    assert!(publish_temp_output(&temp, &destination, true).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"old final");
    assert!(
        !temp.exists(),
        "cancelled job must clean its owned temp output"
    );

    fs::write(&temp, b"new final").unwrap();
    publish_temp_output(&temp, &destination, false).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"new final");
    assert!(!temp.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn real_ffmpeg_one_pass_export_applies_cut_overlay_caption_and_keeps_av_synced() {
    let root = temp_dir("real-one-pass-مسار عربي");
    let ffmpeg = sidecar_binary("ffmpeg");
    let ffprobe = sidecar_binary("ffprobe");
    assert!(
        ffmpeg.is_file(),
        "missing staged ffmpeg sidecar at {}",
        ffmpeg.display()
    );
    assert!(
        ffprobe.is_file(),
        "missing staged ffprobe sidecar at {}",
        ffprobe.display()
    );

    let source = root.join("مصدر فيه مسافات.mp4");
    let overlay = root.join("شعار صغير.png");
    run_ok(
        &ffmpeg,
        [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30:duration=4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=4",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ],
        Some(&source),
    );
    run_ok(
        &ffmpeg,
        [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=yellow:s=48x48:d=0.1",
            "-frames:v",
            "1",
        ],
        Some(&overlay),
    );

    let project = Project {
        schema_version: PROJECT_SCHEMA_VERSION,
        source: SourceState {
            path: Some(source.clone()),
            metadata: Some(SourceMetadata {
                duration: MediaTime(4 * SECOND),
                width: 320,
                height: 180,
                frame_rate: FrameRate {
                    numerator: 30,
                    denominator: 1,
                },
                has_audio: true,
            }),
            download_quality: DownloadQuality::Best,
        },
        selection: Some(range(0, 4)),
        silence: SilenceState {
            detected_regions: vec![range(1, 2)],
            accepted_removed_regions: vec![range(1, 2)],
        },
        overlays: vec![Overlay {
            id: "logo".into(),
            kind: OverlayKind::Image,
            range: range(2, 4),
            geometry: NormalizedRect {
                x: 0.75,
                y: 0.05,
                width: 0.2,
                height: 0.3,
            },
            opacity: 0.9,
            asset_path: Some(overlay),
            aspect_locked: true,
        }],
        captions: CaptionTrack {
            enabled: true,
            cues: vec![CaptionCue {
                start: MediaTime(2_200_000),
                end: MediaTime(3_200_000),
                text: "اختبار export".into(),
            }],
            style: CaptionStyle::default(),
        },
        export: ExportSettings {
            width: 320,
            height: 180,
            frame_rate: FrameRate {
                numerator: 30,
                denominator: 1,
            },
        },
    };
    let output = root.join("الناتج النهائي.mp4");
    let render_plan = compile_render_plan(
        &project,
        ResolvedInput {
            path: source,
            source_offset: MediaTime(0),
            metadata: project.source.metadata.clone().unwrap(),
        },
        output.clone(),
        EncoderSelection::CpuX264,
    )
    .unwrap();
    let prepared = prepare_render_assets(&render_plan, &root.join("job assets")).unwrap();
    let graph = build_filter_graph(&render_plan, &prepared).unwrap();
    let graph_path = root.join("filter graph.txt");
    fs::write(&graph_path, graph).unwrap();
    let temp_output = root.join(".الناتج.tmp.mp4");
    let args = build_ffmpeg_args(&render_plan, &prepared, &graph_path, &temp_output);

    let status = Command::new(&ffmpeg)
        .args(&args)
        .status()
        .expect("run final ffmpeg");
    assert!(status.success(), "final one-pass ffmpeg export failed");
    assert!(temp_output.is_file());

    let probe = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(&temp_output)
        .output()
        .expect("probe final output");
    assert!(probe.status.success());
    let json: serde_json::Value =
        serde_json::from_slice(&probe.stdout).expect("parse ffprobe JSON");
    let streams = json["streams"].as_array().expect("streams array");
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .expect("video stream");
    let audio = streams
        .iter()
        .find(|stream| stream["codec_type"] == "audio")
        .expect("audio stream");
    assert_eq!(video["codec_name"], "h264");
    assert_eq!(video["width"], 320);
    assert_eq!(video["height"], 180);
    assert_eq!(audio["codec_type"], "audio");
    let duration = json["format"]["duration"]
        .as_str()
        .expect("format duration")
        .parse::<f64>()
        .unwrap();
    assert!(
        (2.85..=3.15).contains(&duration),
        "unexpected cut duration: {duration}"
    );
    for stream in [video, audio] {
        let start = stream["start_time"]
            .as_str()
            .unwrap_or("0")
            .parse::<f64>()
            .unwrap_or(0.0);
        assert!(
            start.abs() <= 0.05,
            "stream start is not near zero: {start}"
        );
    }

    publish_temp_output(&temp_output, &output, false).unwrap();
    assert!(output.is_file());
    let _ = fs::remove_dir_all(root);
}

fn sidecar_binary(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-x86_64-pc-windows-msvc.exe"))
}

fn run_ok<'a>(executable: &Path, args: impl IntoIterator<Item = &'a str>, output: Option<&Path>) {
    let mut command = Command::new(executable);
    command.args(args);
    if let Some(output) = output {
        command.arg(output);
    }
    let status = command.status().expect("run fixture ffmpeg");
    assert!(
        status.success(),
        "fixture command failed: {}",
        executable.display()
    );
}
