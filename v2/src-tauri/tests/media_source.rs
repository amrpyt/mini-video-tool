use std::{ffi::OsString, fs, path::PathBuf, process::Command};

use mini_video_tool_v2::{
    domain::{
        project::DownloadQuality,
        time::{MediaTime, TimeRange},
    },
    media::{
        ffprobe::{build_probe_args, parse_ffprobe_json},
        preview::{PreviewFrameRequest, build_preview_frame_args},
        ytdlp::{
            DownloadRangeRequest, build_download_args, build_metadata_args, format_selector,
            parse_youtube_metadata, parse_ytdlp_progress_line, source_offset_for_download,
        },
    },
};

const SECOND: i64 = 1_000_000;

fn strings(args: &[OsString]) -> Vec<String> {
    args.iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn ffprobe_json_keeps_rational_frame_rate_and_accepts_video_without_audio() {
    let json = r#"{
        "streams": [{
            "codec_type": "video",
            "width": 1920,
            "height": 1080,
            "avg_frame_rate": "30000/1001"
        }],
        "format": {"duration": "12.345678"}
    }"#;

    let metadata = parse_ffprobe_json(json).expect("parse ffprobe json");

    assert_eq!(metadata.duration, MediaTime(12_345_678));
    assert_eq!(metadata.width, 1920);
    assert_eq!(metadata.height, 1080);
    assert_eq!(metadata.frame_rate.numerator, 30_000);
    assert_eq!(metadata.frame_rate.denominator, 1_001);
    assert!(!metadata.has_audio);
}

#[test]
fn ffprobe_keeps_unicode_space_path_as_one_argument() {
    let path = PathBuf::from(r"C:\فيديوهات\My Clip 01.mp4");
    let args = build_probe_args(&path);

    assert_eq!(args.last(), Some(&path.into_os_string()));
    assert_eq!(
        args.iter()
            .filter(|arg| arg.to_string_lossy().contains("My Clip 01.mp4"))
            .count(),
        1
    );
}

#[test]
fn youtube_metadata_is_metadata_only_and_parses_required_fields() {
    let args = strings(&build_metadata_args("https://youtu.be/abc123"));
    assert!(args.contains(&"-J".to_string()));
    assert!(args.contains(&"--skip-download".to_string()));
    assert!(args.contains(&"--no-playlist".to_string()));
    assert!(!args.iter().any(|arg| arg == "-o" || arg == "--output"));

    let json = r#"{
        "id": "abc123",
        "title": "Example video",
        "duration": 125.5,
        "thumbnail": "https://img.example/abc123.jpg",
        "formats": [
            {"height": 360, "vcodec": "avc1.42001E"},
            {"height": 720, "vcodec": "avc1.64001F"},
            {"height": 1080, "vcodec": "avc1.640028"}
        ]
    }"#;
    let metadata = parse_youtube_metadata(json).expect("parse yt-dlp metadata");

    assert_eq!(metadata.video_id, "abc123");
    assert_eq!(metadata.title, "Example video");
    assert_eq!(metadata.duration, MediaTime(125_500_000));
    assert_eq!(
        metadata.thumbnail_url.as_deref(),
        Some("https://img.example/abc123.jpg")
    );
    assert!(metadata.qualities.contains(&DownloadQuality::Best));
    assert!(metadata.qualities.contains(&DownloadQuality::P1080));
    assert!(metadata.qualities.contains(&DownloadQuality::P720));
    assert!(metadata.qualities.contains(&DownloadQuality::P360));
}

#[test]
fn download_args_are_strictly_partial_and_reject_full_source_selection() {
    let partial = DownloadRangeRequest {
        url: "https://youtu.be/abc123".into(),
        selection: TimeRange::new(10 * SECOND, 20 * SECOND).expect("partial selection"),
        source_duration: MediaTime(30 * SECOND),
        quality: DownloadQuality::P720,
        output_dir: PathBuf::from(r"C:\media output"),
    };
    let args = strings(&build_download_args(&partial).expect("build partial download args"));
    let section_index = args
        .iter()
        .position(|arg| arg == "--download-sections")
        .expect("partial section flag");
    assert_eq!(args[section_index + 1], "*00:00:10.000-00:00:20.000");
    assert!(args.contains(&"--no-playlist".to_string()));

    let full = DownloadRangeRequest {
        selection: TimeRange::new(0, 30 * SECOND).expect("full selection"),
        ..partial
    };
    assert!(build_download_args(&full).is_err());
}

#[test]
fn explicit_quality_prefers_hls_h264_then_hls_then_bounded_v1_selector() {
    assert_eq!(format_selector(DownloadQuality::Best), "bv*+ba/b");

    let selector = format_selector(DownloadQuality::P720);
    let parts = selector.split('/').collect::<Vec<_>>();
    assert!(parts[0].contains("height<=720"));
    assert!(parts[0].contains("protocol*=m3u8"));
    assert!(parts[0].contains("vcodec^=avc1"));
    assert!(selector.contains("bv[height<=720][protocol*=m3u8]+ba[protocol*=m3u8]"));
    assert!(selector.ends_with("bv*[height<=720]+ba/b[height<=720]"));
}

#[test]
fn preview_frame_args_are_low_resolution_still_image_only() {
    let request = PreviewFrameRequest {
        source: PathBuf::from(r"C:\media\source.mp4"),
        timestamp: MediaTime(5 * SECOND),
        destination: PathBuf::from(r"C:\cache\preview.jpg"),
    };
    let args = strings(&build_preview_frame_args(&request));

    assert!(args.windows(2).any(|pair| pair == ["-frames:v", "1"]));
    assert!(args.iter().any(|arg| arg.contains("scale=640:-2")));
    assert!(args.contains(&"-an".to_string()));
    assert!(!args.iter().any(|arg| arg == "libx264" || arg == "-c:v"));
    assert_eq!(
        args.last().map(String::as_str),
        Some(r"C:\cache\preview.jpg")
    );
}

#[test]
fn yt_dlp_progress_maps_to_structured_job_progress_and_ignores_logs() {
    let progress =
        parse_ytdlp_progress_line("PROGRESS:42.5%|1.2MiB/s|00:08").expect("parse progress line");
    assert_eq!(progress.stage, "download");
    assert_eq!(progress.fraction, Some(0.425));
    assert_eq!(progress.speed.as_deref(), Some("1.2MiB/s"));
    assert_eq!(progress.eta_seconds, Some(8));
    assert!(parse_ytdlp_progress_line("[youtube] Extracting URL").is_none());
}

#[test]
fn keyframe_preroll_preserves_original_source_time_offset() {
    let selection = TimeRange::new(90 * SECOND, 93 * SECOND).expect("selection");
    assert_eq!(
        source_offset_for_download(selection, MediaTime(8_708_000)),
        MediaTime(84_292_000)
    );
    assert_eq!(
        source_offset_for_download(selection, MediaTime(3 * SECOND)),
        MediaTime(90 * SECOND)
    );
}

#[test]
fn real_unicode_space_fixture_probes_expected_media_facts() {
    let dir = std::env::temp_dir().join(format!("mini video tool اختبار {}", std::process::id()));
    fs::create_dir_all(&dir).expect("create unicode fixture directory");
    let fixture = dir.join("clip صوت 01.mp4");

    let ffmpeg = Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=160x90:r=25:d=0.4",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=48000:cl=mono",
            "-shortest",
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
        ])
        .arg(&fixture)
        .status()
        .expect("run ffmpeg fixture generator");
    assert!(ffmpeg.success());

    let output = Command::new("ffprobe")
        .args(build_probe_args(&fixture))
        .output()
        .expect("run ffprobe against fixture");
    assert!(output.status.success());
    let metadata =
        parse_ffprobe_json(&String::from_utf8(output.stdout).expect("utf8 ffprobe json"))
            .expect("parse real ffprobe output");

    assert_eq!((metadata.width, metadata.height), (160, 90));
    assert!(metadata.has_audio);
    assert!(metadata.duration.0 >= 300_000 && metadata.duration.0 <= 700_000);

    fs::remove_dir_all(dir).expect("remove fixture directory");
}
