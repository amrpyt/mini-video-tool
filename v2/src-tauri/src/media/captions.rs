use std::{
    ffi::OsString,
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::{
    domain::{
        project::{CaptionCue, CaptionStyle, CaptionTrack},
        time::MediaTime,
    },
    error::AppError,
};

pub fn parse_srt(text: &str) -> Result<Vec<CaptionCue>, AppError> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = Vec::<Vec<&str>>::new();
    let mut current = Vec::new();
    for line in normalized.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
        } else {
            current.push(line.trim_end());
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    if blocks.is_empty() {
        return Err(AppError::InvalidInput("caption file contains no SRT cues".into()));
    }

    let mut cues = Vec::new();
    for (block_index, lines) in blocks.iter().enumerate() {
        let first = lines
            .first()
            .map(|line| line.trim_start_matches('\u{feff}').trim())
            .unwrap_or("");
        let time_index = if first.parse::<u64>().is_ok() { 1 } else { 0 };
        let Some(time_line) = lines.get(time_index) else {
            return Err(AppError::InvalidInput(format!(
                "malformed SRT cue {}: missing timing line",
                block_index + 1
            )));
        };
        if !time_line.contains("-->") {
            return Err(AppError::InvalidInput(format!(
                "malformed SRT timing line: {time_line}"
            )));
        }
        let Some((start_text, end_text)) = time_line.split_once("-->") else {
            return Err(AppError::InvalidInput(format!(
                "malformed SRT timing line: {time_line}"
            )));
        };
        let start = parse_srt_time(start_text.trim())?;
        let end = parse_srt_time(end_text.split_whitespace().next().unwrap_or(""))?;
        if end <= start {
            return Err(AppError::InvalidInput(
                "caption end must be after caption start".into(),
            ));
        }
        let body = lines[time_index + 1..].join("\n");
        if body.trim().is_empty() {
            return Err(AppError::InvalidInput(format!(
                "malformed SRT cue {}: caption text is empty",
                block_index + 1
            )));
        }
        cues.push(CaptionCue {
            start: MediaTime(start),
            end: MediaTime(end),
            text: body,
        });
    }
    Ok(cues)
}

pub fn parse_ass(text: &str) -> Result<Vec<CaptionCue>, AppError> {
    let mut cues = Vec::new();
    let mut event_format: Option<(usize, usize, usize, usize)> = None;
    let mut saw_section = false;
    let mut in_events = false;
    for raw_line in text.lines() {
        let line = raw_line.trim().trim_start_matches('\u{feff}');
        if line.starts_with('[') && line.ends_with(']') {
            saw_section = true;
            in_events = line.eq_ignore_ascii_case("[Events]");
            continue;
        }
        if saw_section && !in_events {
            continue;
        }
        if let Some(format_text) = line.strip_prefix("Format:") {
            let fields = format_text
                .split(',')
                .map(|field| field.trim().to_ascii_lowercase())
                .collect::<Vec<_>>();
            let start_index = fields.iter().position(|field| field == "start");
            let end_index = fields.iter().position(|field| field == "end");
            let text_index = fields.iter().position(|field| field == "text");
            match (start_index, end_index, text_index) {
                (Some(start), Some(end), Some(text_index)) => {
                    event_format = Some((fields.len(), start, end, text_index));
                }
                _ => {
                    return Err(AppError::InvalidInput(
                        "ASS event Format must include Start, End, and Text".into(),
                    ));
                }
            }
            continue;
        }
        let Some(dialogue_text) = line.strip_prefix("Dialogue:") else {
            continue;
        };
        let (field_count, start_index, end_index, text_index) =
            event_format.unwrap_or((10, 1, 2, 9));
        let fields = dialogue_text.splitn(field_count, ',').collect::<Vec<_>>();
        if fields.len() < field_count {
            return Err(AppError::InvalidInput(format!(
                "malformed ASS dialogue: {line}"
            )));
        }
        let start = parse_ass_time(fields[start_index].trim())?;
        let end = parse_ass_time(fields[end_index].trim())?;
        if end <= start {
            return Err(AppError::InvalidInput(
                "caption end must be after caption start".into(),
            ));
        }
        let text = clean_ass_text(fields[text_index]);
        if text.trim().is_empty() {
            continue;
        }
        cues.push(CaptionCue {
            start: MediaTime(start),
            end: MediaTime(end),
            text,
        });
    }
    Ok(cues)
}

pub fn build_youtube_caption_args(url: &str, output_dir: &Path) -> Vec<OsString> {
    vec![
        "--no-playlist".into(),
        "--skip-download".into(),
        "--write-subs".into(),
        "--write-auto-subs".into(),
        "--sub-langs".into(),
        "ar.*,ar".into(),
        "--sub-format".into(),
        "srt".into(),
        "--convert-subs".into(),
        "srt".into(),
        "-o".into(),
        output_dir
            .join("%(id)s.%(language)s.%(ext)s")
            .into_os_string(),
        url.trim().into(),
    ]
}

pub fn import_captions(path: &Path) -> Result<CaptionTrack, AppError> {
    let text = fs::read_to_string(path).map_err(|error| {
        AppError::InvalidInput(format!(
            "cannot read caption file {}: {error}",
            path.display()
        ))
    })?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let cues = match extension.as_str() {
        "srt" => parse_srt(&text)?,
        "ass" | "ssa" => parse_ass(&text)?,
        _ => {
            return Err(AppError::InvalidInput(
                "caption file must be SRT or ASS".into(),
            ));
        }
    };
    Ok(track_from_cues(cues))
}

pub async fn youtube_captions(app: &AppHandle, url: &str) -> Result<CaptionTrack, AppError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::DownloadFailed(error.to_string()))?
        .as_nanos();
    let output_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| AppError::DownloadFailed(error.to_string()))?
        .join("mini-video-tool-v2")
        .join("captions")
        .join(format!("youtube-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&output_dir).map_err(|error| {
        AppError::DownloadFailed(format!(
            "cannot create caption directory {}: {error}",
            output_dir.display()
        ))
    })?;

    let mut args = build_youtube_caption_args(url, &output_dir);
    if let Ok(executable) = std::env::current_exe()
        && let Some(sidecar_dir) = executable.parent()
    {
        args.splice(
            0..0,
            [
                OsString::from("--ffmpeg-location"),
                sidecar_dir.as_os_str().to_owned(),
            ],
        );
    }

    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|error| AppError::DownloadFailed(error.to_string()))?
        .args(args)
        .output()
        .await
        .map_err(|error| AppError::DownloadFailed(error.to_string()))?;
    if !output.status.success() {
        return Err(AppError::DownloadFailed(last_diagnostic(&output.stderr)));
    }

    let mut candidates = fs::read_dir(&output_dir)
        .map_err(|error| AppError::DownloadFailed(error.to_string()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("srt"))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        (!name.contains(".ar."), name)
    });
    let Some(path) = candidates.first() else {
        return Ok(track_from_cues(Vec::new()));
    };
    import_captions(path)
}

fn track_from_cues(cues: Vec<CaptionCue>) -> CaptionTrack {
    CaptionTrack {
        enabled: !cues.is_empty(),
        cues,
        style: CaptionStyle::default(),
    }
}

fn parse_srt_time(value: &str) -> Result<i64, AppError> {
    let normalized = value.replace('.', ",");
    let parts = normalized.split(':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(AppError::InvalidInput(format!(
            "invalid SRT timestamp: {value}"
        )));
    }
    let (seconds_text, millis_text) = parts[2]
        .split_once(',')
        .ok_or_else(|| AppError::InvalidInput(format!("invalid SRT timestamp: {value}")))?;
    if millis_text.len() != 3 {
        return Err(AppError::InvalidInput(format!(
            "invalid SRT timestamp: {value}"
        )));
    }
    let hours = parse_u64(parts[0], value)?;
    let minutes = parse_u64(parts[1], value)?;
    let seconds = parse_u64(seconds_text, value)?;
    let millis = parse_u64(millis_text, value)?;
    if minutes >= 60 || seconds >= 60 {
        return Err(AppError::InvalidInput(format!(
            "invalid SRT timestamp: {value}"
        )));
    }
    compose_time_us(hours, minutes, seconds, millis * 1_000, value)
}

fn parse_ass_time(value: &str) -> Result<i64, AppError> {
    let parts = value.split(':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(AppError::InvalidInput(format!(
            "invalid ASS timestamp: {value}"
        )));
    }
    let (seconds_text, fraction_text) = parts[2]
        .split_once('.')
        .ok_or_else(|| AppError::InvalidInput(format!("invalid ASS timestamp: {value}")))?;
    if fraction_text.is_empty()
        || fraction_text.len() > 6
        || !fraction_text
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return Err(AppError::InvalidInput(format!(
            "invalid ASS timestamp: {value}"
        )));
    }
    let hours = parse_u64(parts[0], value)?;
    let minutes = parse_u64(parts[1], value)?;
    let seconds = parse_u64(seconds_text, value)?;
    if minutes >= 60 || seconds >= 60 {
        return Err(AppError::InvalidInput(format!(
            "invalid ASS timestamp: {value}"
        )));
    }
    let mut micros_text = fraction_text.to_owned();
    while micros_text.len() < 6 {
        micros_text.push('0');
    }
    let micros = parse_u64(&micros_text, value)?;
    compose_time_us(hours, minutes, seconds, micros, value)
}

fn parse_u64(value: &str, original: &str) -> Result<u64, AppError> {
    value
        .parse::<u64>()
        .map_err(|_| AppError::InvalidInput(format!("invalid caption timestamp: {original}")))
}

fn compose_time_us(
    hours: u64,
    minutes: u64,
    seconds: u64,
    micros: u64,
    original: &str,
) -> Result<i64, AppError> {
    let total_seconds = hours
        .checked_mul(3_600)
        .and_then(|value| value.checked_add(minutes * 60))
        .and_then(|value| value.checked_add(seconds))
        .ok_or_else(|| AppError::InvalidInput(format!("timestamp overflow: {original}")))?;
    let total = total_seconds
        .checked_mul(1_000_000)
        .and_then(|value| value.checked_add(micros))
        .ok_or_else(|| AppError::InvalidInput(format!("timestamp overflow: {original}")))?;
    i64::try_from(total)
        .map_err(|_| AppError::InvalidInput(format!("timestamp overflow: {original}")))
}

fn clean_ass_text(value: &str) -> String {
    let mut output = String::new();
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '{' => inside_tag = true,
            '}' if inside_tag => inside_tag = false,
            _ if !inside_tag => output.push(character),
            _ => {}
        }
    }
    output.replace("\\N", "\n").replace("\\n", "\n")
}

fn last_diagnostic(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("yt-dlp caption download failed")
        .trim()
        .to_owned()
}
