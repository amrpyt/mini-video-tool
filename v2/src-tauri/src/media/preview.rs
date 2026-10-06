use std::{ffi::OsString, fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    domain::time::{MediaTime, TimeRange},
    error::AppError,
    jobs::JobManager,
};

use super::process::run_auxiliary_sidecar;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrameRequest {
    pub source: PathBuf,
    pub timestamp: MediaTime,
    pub destination: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmstripRequest {
    pub source: PathBuf,
    pub range: TimeRange,
    pub count: u32,
    pub destination_dir: PathBuf,
}

pub fn build_preview_frame_args(request: &PreviewFrameRequest) -> Vec<OsString> {
    vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        seconds_arg(request.timestamp).into(),
        "-i".into(),
        request.source.as_os_str().to_owned(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=640:-2:force_original_aspect_ratio=decrease".into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        request.destination.as_os_str().to_owned(),
    ]
}

pub fn build_filmstrip_args(request: &FilmstripRequest) -> Result<Vec<OsString>, AppError> {
    if request.count == 0 || request.count > 60 {
        return Err(AppError::InvalidInput(
            "filmstrip frame count must be between 1 and 60".into(),
        ));
    }
    if request.range.start().0 < 0 {
        return Err(AppError::InvalidInput(
            "filmstrip range cannot start before zero".into(),
        ));
    }
    let duration = MediaTime(request.range.end().0 - request.range.start().0);
    let filter = format!(
        "fps={}/{},scale=320:-2:force_original_aspect_ratio=decrease",
        request.count,
        seconds_arg(duration)
    );
    let destination = request.destination_dir.join("frame-%03d.jpg");
    Ok(vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        seconds_arg(request.range.start()).into(),
        "-t".into(),
        seconds_arg(duration).into(),
        "-i".into(),
        request.source.as_os_str().to_owned(),
        "-vf".into(),
        filter.into(),
        "-frames:v".into(),
        request.count.to_string().into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        destination.into_os_string(),
    ])
}

pub async fn extract_preview_frame(
    app: &AppHandle,
    manager: &JobManager,
    request: &PreviewFrameRequest,
) -> Result<PathBuf, AppError> {
    if request.timestamp.0 < 0 {
        return Err(AppError::InvalidInput(
            "preview timestamp cannot be negative".into(),
        ));
    }
    if let Some(parent) = request.destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::MediaProbeFailed(format!(
                "cannot create preview directory {}: {error}",
                parent.display()
            ))
        })?;
    }
    run_ffmpeg(app, manager, build_preview_frame_args(request)).await?;
    Ok(request.destination.clone())
}

pub async fn extract_filmstrip(
    app: &AppHandle,
    manager: &JobManager,
    request: &FilmstripRequest,
) -> Result<Vec<PathBuf>, AppError> {
    let args = build_filmstrip_args(request)?;
    fs::create_dir_all(&request.destination_dir).map_err(|error| {
        AppError::MediaProbeFailed(format!(
            "cannot create filmstrip directory {}: {error}",
            request.destination_dir.display()
        ))
    })?;
    run_ffmpeg(app, manager, args).await?;
    Ok((1..=request.count)
        .map(|index| {
            request
                .destination_dir
                .join(format!("frame-{index:03}.jpg"))
        })
        .collect())
}

async fn run_ffmpeg(
    app: &AppHandle,
    manager: &JobManager,
    args: Vec<OsString>,
) -> Result<(), AppError> {
    let output = run_auxiliary_sidecar(app, manager, "ffmpeg", args)
        .await
        .map_err(AppError::MediaProbeFailed)?;
    if output.succeeded() {
        return Ok(());
    }
    if let Some(error) = output.process_error {
        return Err(AppError::MediaProbeFailed(error));
    }
    let diagnostic = String::from_utf8_lossy(&output.stderr)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("ffmpeg preview extraction failed")
        .trim()
        .to_owned();
    Err(AppError::MediaProbeFailed(diagnostic))
}

fn seconds_arg(time: MediaTime) -> String {
    format!(
        "{}.{:06}",
        time.0 / 1_000_000,
        time.0.unsigned_abs() % 1_000_000
    )
}
