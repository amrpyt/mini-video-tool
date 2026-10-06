use std::{ffi::OsString, path::Path};

use crate::{
    domain::{
        project::SourceMetadata,
        time::{FrameRate, MediaTime},
    },
    error::AppError,
    jobs::JobManager,
};
use serde::Deserialize;
use tauri::AppHandle;

use super::process::run_auxiliary_sidecar;

#[derive(Deserialize)]
struct ProbeDocument {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: ProbeFormat,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
}

#[derive(Default, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

pub fn build_probe_args(path: &Path) -> Vec<OsString> {
    vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_streams".into(),
        "-show_format".into(),
        path.as_os_str().to_owned(),
    ]
}

pub fn parse_ffprobe_json(json: &str) -> Result<SourceMetadata, AppError> {
    let document: ProbeDocument = serde_json::from_str(json)
        .map_err(|error| AppError::MediaProbeFailed(format!("invalid ffprobe JSON: {error}")))?;
    let video = document
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| AppError::UnsupportedMedia("source has no video stream".into()))?;

    let width = video
        .width
        .ok_or_else(|| AppError::MediaProbeFailed("video width is missing".into()))?;
    let height = video
        .height
        .ok_or_else(|| AppError::MediaProbeFailed("video height is missing".into()))?;
    let frame_rate = video
        .avg_frame_rate
        .as_deref()
        .and_then(parse_frame_rate)
        .or_else(|| video.r_frame_rate.as_deref().and_then(parse_frame_rate))
        .ok_or_else(|| {
            AppError::MediaProbeFailed("video frame rate is missing or invalid".into())
        })?;
    let duration = document
        .format
        .duration
        .as_deref()
        .or(video.duration.as_deref())
        .ok_or_else(|| AppError::MediaProbeFailed("media duration is missing".into()))
        .and_then(parse_seconds)?;
    if duration.0 <= 0 {
        return Err(AppError::MediaProbeFailed(
            "media duration must be positive".into(),
        ));
    }

    Ok(SourceMetadata {
        duration,
        width,
        height,
        frame_rate,
        has_audio: document
            .streams
            .iter()
            .any(|stream| stream.codec_type.as_deref() == Some("audio")),
    })
}

pub async fn probe_source(
    app: &AppHandle,
    manager: &JobManager,
    path: &Path,
) -> Result<SourceMetadata, AppError> {
    let output = run_auxiliary_sidecar(app, manager, "ffprobe", build_probe_args(path))
        .await
        .map_err(AppError::MediaProbeFailed)?;
    if !output.succeeded() {
        if let Some(error) = output.process_error {
            return Err(AppError::MediaProbeFailed(error));
        }
        return Err(AppError::MediaProbeFailed(last_diagnostic(&output.stderr)));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|error| {
        AppError::MediaProbeFailed(format!("ffprobe output is not UTF-8: {error}"))
    })?;
    parse_ffprobe_json(&stdout)
}

pub(crate) fn parse_seconds(value: &str) -> Result<MediaTime, AppError> {
    let text = value.trim();
    if text.is_empty() || text.starts_with('-') {
        return Err(AppError::MediaProbeFailed("invalid media duration".into()));
    }
    let (whole, fractional) = text.split_once('.').unwrap_or((text, ""));
    let seconds = whole
        .parse::<i128>()
        .map_err(|_| AppError::MediaProbeFailed("invalid media duration".into()))?;
    if !fractional
        .chars()
        .all(|character| character.is_ascii_digit())
    {
        return Err(AppError::MediaProbeFailed("invalid media duration".into()));
    }
    let digits = fractional.chars().take(6).collect::<String>();
    let micros = if digits.is_empty() {
        0_i128
    } else {
        let padded = format!("{digits:0<6}");
        padded
            .parse::<i128>()
            .map_err(|_| AppError::MediaProbeFailed("invalid media duration".into()))?
    };
    let total = seconds
        .checked_mul(1_000_000)
        .and_then(|seconds| seconds.checked_add(micros))
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| AppError::MediaProbeFailed("media duration is out of range".into()))?;
    Ok(MediaTime(total))
}

fn parse_frame_rate(value: &str) -> Option<FrameRate> {
    let (numerator, denominator) = value.trim().split_once('/')?;
    let numerator = numerator.parse::<u32>().ok()?;
    let denominator = denominator.parse::<u32>().ok()?;
    (numerator != 0 && denominator != 0).then_some(FrameRate {
        numerator,
        denominator,
    })
}

fn last_diagnostic(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("ffprobe failed")
        .trim()
        .to_owned()
}
