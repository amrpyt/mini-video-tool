use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

use mini_video_tool_v2::{
    domain::{
        project::{
            CaptionCue, CaptionStyle, CaptionTrack, DownloadQuality, ExportSettings,
            NormalizedRect, Overlay, OverlayKind, PROJECT_SCHEMA_VERSION, Project, SilenceState,
            SourceState,
        },
        render_plan::{EncoderSelection, ResolvedInput, compile_render_plan},
        time::{FrameRate, MediaTime, TimeRange},
    },
    media::{
        export::{
            build_ffmpeg_args, build_filter_graph, prepare_render_assets, publish_temp_output,
            validate_rendered_output,
        },
        ffprobe::{build_probe_args, parse_ffprobe_json},
        silence::{AnalyzeSilenceRequest, build_analysis_args, parse_silence_regions},
    },
};

#[test]
fn windows_local_backend_smoke() {
    let root = temp_dir("windows-local");
    let ffmpeg = sidecar("ffmpeg");
    let ffprobe = sidecar("ffprobe");
    assert!(
        ffmpeg.is_file(),
        "missing staged ffmpeg: {}",
        ffmpeg.display()
    );
    assert!(
        ffprobe.is_file(),
        "missing staged ffprobe: {}",
        ffprobe.display()
    );

    let source = root.join("مصدر smoke فيه مسافات.mp4");
    create_fixture(&ffmpeg, &source);

    let source_probe = run(&ffprobe, build_probe_args(&source));
    assert!(source_probe.status.success(), "ffprobe source failed");
    let metadata = parse_ffprobe_json(&String::from_utf8(source_probe.stdout).unwrap())
        .expect("parse source probe");
    assert_eq!((metadata.width, metadata.height), (320, 180));
    assert!(metadata.has_audio);

    let selection = TimeRange::new(500_000, 5_500_000).unwrap();
    let waveform = root.join("waveform.png");
    let analysis_request = AnalyzeSilenceRequest {
        source: source.clone(),
        selection,
        source_offset: MediaTime(0),
        local_duration: metadata.duration,
        has_audio: metadata.has_audio,
        waveform_destination: waveform.clone(),
    };
    let analysis = run(&ffmpeg, build_analysis_args(&analysis_request).unwrap());
    assert!(analysis.status.success(), "silence analysis ffmpeg failed");
    assert!(
        waveform.is_file(),
        "silence analysis did not produce waveform"
    );
    let detected = parse_silence_regions(
        &String::from_utf8_lossy(&analysis.stderr),
        selection.end().0 - selection.start().0,
        selection.start().0,
    )
    .expect("parse silence regions");
    assert!(!detected.is_empty(), "fixture silence was not detected");

    let project = Project {
        schema_version: PROJECT_SCHEMA_VERSION,
        source: SourceState {
            path: Some(source.clone()),
            metadata: Some(metadata.clone()),
            download_quality: DownloadQuality::Best,
            ..Default::default()
        },
        selection: Some(selection),
        silence: SilenceState {
            detected_regions: detected.clone(),
            accepted_removed_regions: detected,
        },
        overlays: vec![Overlay {
            id: "smoke-black-bar".into(),
            kind: OverlayKind::BlackBar,
            range: TimeRange::new(1_000_000, 5_000_000).unwrap(),
            geometry: NormalizedRect {
                x: 0.05,
                y: 0.78,
                width: 0.9,
                height: 0.16,
            },
            opacity: 0.75,
            asset_path: None,
            aspect_locked: false,
        }],
        captions: CaptionTrack {
            enabled: true,
            cues: vec![CaptionCue {
                start: MediaTime(3_400_000),
                end: MediaTime(4_400_000),
                text: "Smoke caption سليم".into(),
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

    let final_output = root.join("الناتج النهائي.mp4");
    let plan = compile_render_plan(
        &project,
        ResolvedInput {
            path: source,
            source_offset: MediaTime(0),
            metadata,
        },
        final_output.clone(),
        EncoderSelection::CpuX264,
    )
    .expect("compile render plan");
    let job_dir = root.join("job-assets");
    let prepared = prepare_render_assets(&plan, &job_dir).expect("prepare render assets");
    let graph_path = root.join("filter-graph.txt");
    fs::write(
        &graph_path,
        build_filter_graph(&plan, &prepared).expect("build filter graph"),
    )
    .unwrap();
    let temp_output = root.join(".final.tmp.mp4");

    let mut final_encode_processes = 0_u32;
    final_encode_processes += 1;
    let export = run(
        &ffmpeg,
        build_ffmpeg_args(&plan, &prepared, &graph_path, &temp_output),
    );
    assert!(export.status.success(), "final export ffmpeg failed");
    assert_eq!(
        final_encode_processes, 1,
        "final export must encode exactly once"
    );

    let output_probe = run(&ffprobe, build_probe_args(&temp_output));
    assert!(output_probe.status.success(), "ffprobe final output failed");
    let output_metadata = parse_ffprobe_json(&String::from_utf8(output_probe.stdout).unwrap())
        .expect("parse final probe");
    validate_rendered_output(&plan, &output_metadata).expect("validate final output");
    assert!(output_metadata.has_audio);

    publish_temp_output(&temp_output, &final_output, false).expect("publish final output");
    assert!(final_output.is_file());
    assert!(!temp_output.exists());
    fs::remove_dir_all(&job_dir).unwrap();
    assert!(!job_dir.exists());

    println!(
        "PASS local smoke: probe -> partial selection -> silence decision -> overlay -> captions -> one final encode -> ffprobe -> cleanup"
    );
    fs::remove_dir_all(&root).unwrap();
    assert!(!root.exists());
}

fn create_fixture(ffmpeg: &Path, destination: &Path) {
    let args = [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30:duration=6",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=mono:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:sample_rate=48000:duration=3",
        "-filter_complex",
        "[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]",
        "-map",
        "0:v",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
    ];
    let mut command = Command::new(ffmpeg);
    command.args(args).arg(destination);
    assert!(command.status().expect("generate smoke fixture").success());
}

fn run<I, S>(executable: &Path, args: I) -> Output
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    Command::new(executable)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("failed to run {}: {error}", executable.display()))
}

fn sidecar(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-x86_64-pc-windows-msvc.exe"))
}

fn temp_dir(label: &str) -> PathBuf {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("mvt-{label}-{}-{id}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    path
}
