use std::path::PathBuf;

use mini_video_tool_v2::media::captions::{build_youtube_caption_args, parse_ass, parse_srt};

#[test]
fn srt_uses_integer_microseconds_and_preserves_multiline_text() {
    let cues = parse_srt("1\n00:00:01,250 --> 00:00:03,005\nFirst line\nSecond line\n")
        .expect("parse SRT");
    assert_eq!(cues.len(), 1);
    assert_eq!(cues[0].start.0, 1_250_000);
    assert_eq!(cues[0].end.0, 3_005_000);
    assert_eq!(cues[0].text, "First line\nSecond line");
}

#[test]
fn ass_uses_integer_microseconds_and_preserves_line_breaks() {
    let source = r#"[Script Info]
Title: test
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.23,0:00:03.45,Default,,0,0,0,,First\NSecond
"#;
    let cues = parse_ass(source).expect("parse ASS");
    assert_eq!(cues.len(), 1);
    assert_eq!(cues[0].start.0, 1_230_000);
    assert_eq!(cues[0].end.0, 3_450_000);
    assert_eq!(cues[0].text, "First\nSecond");
}

#[test]
fn ass_respects_declared_event_field_order_and_ignores_comments() {
    let source = r#"[Events]
Format: Layer, Style, Start, End, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,Default,0:00:00.00,0:00:09.00,,0,0,0,,ignore me
Dialogue: 0,Default,0:00:01.20,0:00:02.34,,0,0,0,,Hello, world
"#;
    let cues = parse_ass(source).expect("parse reordered ASS");
    assert_eq!(cues.len(), 1);
    assert_eq!(cues[0].start.0, 1_200_000);
    assert_eq!(cues[0].end.0, 2_340_000);
    assert_eq!(cues[0].text, "Hello, world");
}

#[test]
fn ass_ignores_non_event_format_sections() {
    let source = r#"[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Arial,48,&H00FFFFFF
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello
"#;
    let cues = parse_ass(source).expect("parse ASS with style section");
    assert_eq!(cues.len(), 1);
    assert_eq!(cues[0].text, "Hello");
}

#[test]
fn malformed_caption_timestamps_return_a_typed_error() {
    assert!(parse_srt("1\nnot-a-time --> 00:00:03,000\nBad").is_err());
    assert!(parse_ass("Dialogue: 0,bad,0:00:03.00,Default,,0,0,0,,Bad").is_err());
    assert!(parse_srt("1\n00:00:03,000 --> 00:00:03,000\nBad").is_err());
}

#[test]
fn srt_rejects_malformed_blocks_instead_of_partially_importing_them() {
    let source = "1\n00:00:01,000 --> 00:00:02,000\nGood\n\nBROKEN BLOCK\ntext only\n";
    assert!(parse_srt(source).is_err());
}

#[test]
fn srt_accepts_whitespace_only_block_separators() {
    let source =
        "1\n00:00:01,000 --> 00:00:02,000\nOne\n   \n2\n00:00:03,000 --> 00:00:04,000\nTwo\n";
    let cues = parse_srt(source).expect("parse whitespace-separated SRT cues");
    assert_eq!(cues.len(), 2);
    assert_eq!(cues[0].text, "One");
    assert_eq!(cues[1].text, "Two");
}

#[test]
fn youtube_caption_args_are_subtitles_only_and_prefer_arabic() {
    let args = build_youtube_caption_args(
        "https://youtu.be/abc123",
        &PathBuf::from(r"C:\cache\captions"),
    );
    let rendered = args
        .iter()
        .map(|value| value.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(rendered.contains("--skip-download"));
    assert!(rendered.contains("--write-subs"));
    assert!(rendered.contains("--write-auto-subs"));
    assert!(rendered.contains("--sub-langs ar.*,ar"));
    assert!(rendered.contains("--sub-format srt"));
    assert!(!rendered.contains("bv*"));
    assert!(!rendered.contains("--format"));
}
