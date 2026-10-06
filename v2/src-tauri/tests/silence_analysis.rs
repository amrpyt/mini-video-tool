use std::path::PathBuf;

use mini_video_tool_v2::{
    domain::time::{MediaTime, TimeRange},
    error::AppError,
    media::silence::{
        AnalyzeSilenceRequest, build_analysis_args, parse_silence_regions,
        validate_analysis_request,
    },
};

fn request(has_audio: bool) -> AnalyzeSilenceRequest {
    AnalyzeSilenceRequest {
        source: PathBuf::from(r"C:\فيديوهات\Clip 01.mp4"),
        selection: TimeRange::new(90_000_000, 93_000_000).unwrap(),
        source_offset: MediaTime(84_292_000),
        local_duration: MediaTime(12_000_000),
        has_audio,
        waveform_destination: PathBuf::from(r"C:\cache\wave.png"),
    }
}

#[test]
fn parser_applies_margin_and_maps_relative_detection_back_to_source_time() {
    let stderr = r#"
[silencedetect @ 1] silence_start: 0.5
[silencedetect @ 1] silence_end: 2.5 | silence_duration: 2
"#;
    let regions = parse_silence_regions(stderr, 3_000_000, 90_000_000).unwrap();

    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].start().0, 90_700_000);
    assert_eq!(regions[0].end().0, 92_300_000);
}

#[test]
fn parser_closes_trailing_silence_at_analysis_end_and_accepts_no_silence() {
    let trailing = "[silencedetect @ 1] silence_start: 1.25";
    let regions = parse_silence_regions(trailing, 3_000_000, 10_000_000).unwrap();
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].start().0, 11_450_000);
    assert_eq!(regions[0].end().0, 12_800_000);

    assert!(
        parse_silence_regions("normal ffmpeg output", 3_000_000, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn no_audio_is_typed_unsupported_before_process_setup() {
    let error = validate_analysis_request(&request(false)).unwrap_err();
    assert!(matches!(error, AppError::UnsupportedMedia(_)));
}

#[test]
fn one_ffmpeg_graph_detects_silence_and_outputs_only_a_waveform_image() {
    let args = build_analysis_args(&request(true)).unwrap();
    let rendered = args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");

    assert!(rendered.contains("-ss 5.708000"));
    assert!(rendered.contains("-t 3.000000"));
    assert!(rendered.contains("asplit=2"));
    assert!(rendered.contains("silencedetect=noise=-35dB:d=0.6"));
    assert!(rendered.contains("showwavespic="));
    assert!(rendered.contains("-frames:v 1"));
    assert!(rendered.contains("-progress pipe:1"));
    assert!(!rendered.contains("libx264"));
    assert!(!rendered.contains("-c:v"));
}
