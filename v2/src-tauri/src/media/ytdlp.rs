use std::{ffi::OsString, fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_shell::{ShellExt, process::CommandEvent};

use crate::{
    domain::{
        project::{DownloadQuality, SourceMetadata},
        time::{MediaTime, TimeRange},
    },
    error::AppError,
    jobs::{JobKind, JobManager, JobOutcome, JobProgress, JobStatus},
    media::ffprobe,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeMetadata {
    pub video_id: String,
    pub title: String,
    pub duration: MediaTime,
    pub thumbnail_url: Option<String>,
    pub qualities: Vec<DownloadQuality>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRangeRequest {
    pub url: String,
    pub selection: TimeRange,
    pub source_duration: MediaTime,
    pub quality: DownloadQuality,
    pub output_dir: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDownload {
    pub path: PathBuf,
    pub source_offset: MediaTime,
    pub metadata: SourceMetadata,
}

pub fn build_metadata_args(url: &str) -> Vec<OsString> {
    vec![
        "--no-playlist".into(),
        "--skip-download".into(),
        "-J".into(),
        url.trim().into(),
    ]
}

pub fn parse_youtube_metadata(json: &str) -> Result<YouTubeMetadata, AppError> {
    let value: Value = serde_json::from_str(json)
        .map_err(|error| AppError::DownloadFailed(format!("invalid yt-dlp metadata: {error}")))?;
    let video_id = required_string(&value, "id")?;
    let title = required_string(&value, "title")?;
    let duration_value = value
        .get("duration")
        .ok_or_else(|| AppError::DownloadFailed("YouTube duration is missing".into()))?;
    let duration = match duration_value {
        Value::Number(number) => ffprobe::parse_seconds(&number.to_string()),
        Value::String(text) => ffprobe::parse_seconds(text),
        _ => Err(AppError::MediaProbeFailed("invalid media duration".into())),
    }
    .map_err(|error| AppError::DownloadFailed(error.to_string()))?;
    let thumbnail_url = value
        .get("thumbnail")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let mut qualities = vec![DownloadQuality::Best];
    let formats = value
        .get("formats")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for (quality, height) in [
        (DownloadQuality::P1080, 1080_u64),
        (DownloadQuality::P720, 720),
        (DownloadQuality::P480, 480),
        (DownloadQuality::P360, 360),
    ] {
        if formats
            .iter()
            .any(|format| format.get("height").and_then(Value::as_u64) == Some(height))
        {
            qualities.push(quality);
        }
    }

    Ok(YouTubeMetadata {
        video_id,
        title,
        duration,
        thumbnail_url,
        qualities,
    })
}

pub fn format_selector(quality: DownloadQuality) -> String {
    let height = match quality {
        DownloadQuality::Best => return "bv*+ba/b".into(),
        DownloadQuality::P1080 => 1080,
        DownloadQuality::P720 => 720,
        DownloadQuality::P480 => 480,
        DownloadQuality::P360 => 360,
    };
    let height_filter = format!("[height<={height}]");
    let hls_h264 = format!(
        "bv{height_filter}[protocol*=m3u8][vcodec^=avc1]+ba[protocol*=m3u8]/b{height_filter}[protocol*=m3u8][vcodec^=avc1]"
    );
    let hls_any = format!(
        "bv{height_filter}[protocol*=m3u8]+ba[protocol*=m3u8]/b{height_filter}[protocol*=m3u8]"
    );
    let bounded = format!("bv*{height_filter}+ba/b{height_filter}");
    format!("{hls_h264}/{hls_any}/{bounded}")
}

pub fn build_download_args(request: &DownloadRangeRequest) -> Result<Vec<OsString>, AppError> {
    validate_partial_request(request)?;
    let section = format!(
        "*{}-{}",
        format_timestamp(request.selection.start()),
        format_timestamp(request.selection.end())
    );
    let quality_tag = match request.quality {
        DownloadQuality::Best => "best",
        DownloadQuality::P1080 => "p1080",
        DownloadQuality::P720 => "p720",
        DownloadQuality::P480 => "p480",
        DownloadQuality::P360 => "p360",
    };
    let output_name = format!(
        "%(title).120B [%(id)s] [s{}-e{}-{quality_tag}].%(ext)s",
        request.selection.start().0,
        request.selection.end().0
    );
    let output_template = request.output_dir.join(output_name).into_os_string();

    Ok(vec![
        "--no-playlist".into(),
        "--newline".into(),
        "--download-sections".into(),
        section.into(),
        "--progress".into(),
        "--progress-template".into(),
        "download:PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"
            .into(),
        "--print".into(),
        "after_move:FINAL_FILE:%(filepath)s".into(),
        "-f".into(),
        format_selector(request.quality).into(),
        "--no-overwrites".into(),
        "-o".into(),
        output_template,
        request.url.trim().into(),
    ])
}

pub fn parse_ytdlp_progress_line(line: &str) -> Option<JobProgress> {
    let payload = line.trim().strip_prefix("PROGRESS:")?;
    let mut parts = payload.split('|');
    let percent = parts
        .next()?
        .trim()
        .trim_end_matches('%')
        .parse::<f64>()
        .ok()?;
    let speed = optional_text(parts.next());
    let eta_seconds = optional_text(parts.next()).and_then(|eta| parse_eta(&eta));
    Some(JobProgress {
        stage: "download".into(),
        fraction: Some((percent / 100.0).clamp(0.0, 1.0)),
        speed,
        eta_seconds,
        message: format!("Downloading {:.1}%", percent.clamp(0.0, 100.0)),
    })
}

pub async fn youtube_metadata(app: &AppHandle, url: &str) -> Result<YouTubeMetadata, AppError> {
    if url.trim().is_empty() {
        return Err(AppError::InvalidInput("YouTube URL is required".into()));
    }
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|error| AppError::DownloadFailed(error.to_string()))?
        .args(build_metadata_args(url))
        .output()
        .await
        .map_err(|error| AppError::DownloadFailed(error.to_string()))?;
    if !output.status.success() {
        return Err(AppError::DownloadFailed(last_diagnostic(&output.stderr)));
    }
    let stdout = String::from_utf8(output.stdout).map_err(|error| {
        AppError::DownloadFailed(format!("yt-dlp output is not UTF-8: {error}"))
    })?;
    parse_youtube_metadata(&stdout)
}

pub async fn download_range(
    app: &AppHandle,
    manager: &JobManager,
    request: &DownloadRangeRequest,
) -> Result<ResolvedDownload, AppError> {
    let mut args = build_download_args(request)?;
    let executable = std::env::current_exe()
        .map_err(|error| AppError::DownloadFailed(format!("cannot locate sidecars: {error}")))?;
    let sidecar_dir = executable
        .parent()
        .ok_or_else(|| AppError::DownloadFailed("application path has no parent".into()))?;
    args.splice(
        0..0,
        [
            OsString::from("--ffmpeg-location"),
            sidecar_dir.as_os_str().to_owned(),
        ],
    );
    fs::create_dir_all(&request.output_dir).map_err(|error| {
        AppError::DownloadFailed(format!(
            "cannot create download directory {}: {error}",
            request.output_dir.display()
        ))
    })?;

    let job = manager.begin(JobKind::Download)?;
    let command = match app.shell().sidecar("yt-dlp") {
        Ok(command) => command.args(args),
        Err(error) => {
            manager.finish(job, JobOutcome::Failed)?;
            return Err(AppError::DownloadFailed(error.to_string()));
        }
    };
    let spawned = command.spawn();
    let (mut receiver, child) = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            manager.finish(job, JobOutcome::Failed)?;
            return Err(AppError::DownloadFailed(error.to_string()));
        }
    };
    manager.attach_process(job, child.pid())?;

    let mut final_path = None;
    let mut exit_code = None;
    let mut process_error = None;
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                if let Some(path) = line.trim().strip_prefix("FINAL_FILE:") {
                    final_path = Some(PathBuf::from(path.trim()));
                }
                if let Some(progress) = parse_ytdlp_progress_line(&line) {
                    manager.update_progress(job, progress)?;
                }
            }
            CommandEvent::Error(error) => process_error = Some(error),
            CommandEvent::Terminated(payload) => {
                manager.process_exited(job)?;
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    if matches!(
        manager.status(job)?,
        JobStatus::Cancelling | JobStatus::Cancelled
    ) {
        manager.finish(job, JobOutcome::Cancelled)?;
        return Err(AppError::Cancelled);
    }
    if exit_code != Some(0) || process_error.is_some() {
        manager.finish(job, JobOutcome::Failed)?;
        return Err(AppError::DownloadFailed(process_error.unwrap_or_else(
            || format!("yt-dlp exited with code {exit_code:?}"),
        )));
    }
    let path = match final_path {
        Some(path) => path,
        None => {
            manager.finish(job, JobOutcome::Failed)?;
            return Err(AppError::DownloadFailed(
                "yt-dlp completed without reporting the downloaded file".into(),
            ));
        }
    };
    if !path.is_file() {
        manager.finish(job, JobOutcome::Failed)?;
        return Err(AppError::DownloadFailed(format!(
            "yt-dlp reported a missing downloaded file: {}",
            path.display()
        )));
    }
    manager.finish(job, JobOutcome::Completed)?;
    let metadata = ffprobe::probe_source(app, &path).await?;
    let source_offset = source_offset_for_download(request.selection, metadata.duration);

    Ok(ResolvedDownload {
        path,
        source_offset,
        metadata,
    })
}

pub fn source_offset_for_download(
    selection: TimeRange,
    downloaded_duration: MediaTime,
) -> MediaTime {
    MediaTime(
        selection
            .end()
            .0
            .saturating_sub(downloaded_duration.0)
            .max(0),
    )
}

fn validate_partial_request(request: &DownloadRangeRequest) -> Result<(), AppError> {
    if request.url.trim().is_empty() {
        return Err(AppError::InvalidInput("YouTube URL is required".into()));
    }
    if request.source_duration.0 <= 0
        || request.selection.start().0 < 0
        || request.selection.end().0 > request.source_duration.0
    {
        return Err(AppError::InvalidInput(
            "selection must be inside the source duration".into(),
        ));
    }
    if request.selection.start().0 == 0 && request.selection.end() == request.source_duration {
        return Err(AppError::InvalidInput(
            "YouTube download requires a partial source selection".into(),
        ));
    }
    Ok(())
}

fn format_timestamp(time: MediaTime) -> String {
    let total = time.0.max(0);
    let hours = total / 3_600_000_000;
    let remainder = total % 3_600_000_000;
    let minutes = remainder / 60_000_000;
    let remainder = remainder % 60_000_000;
    let seconds = remainder / 1_000_000;
    let micros = remainder % 1_000_000;
    let fraction = if micros == 0 {
        "000".into()
    } else {
        let six = format!("{micros:06}");
        let trimmed = six.trim_end_matches('0');
        if trimmed.len() < 3 {
            format!("{trimmed:0<3}")
        } else {
            trimmed.to_owned()
        }
    };
    format!("{hours:02}:{minutes:02}:{seconds:02}.{fraction}")
}

fn parse_eta(value: &str) -> Option<u64> {
    let parts = value.split(':').collect::<Vec<_>>();
    match parts.as_slice() {
        [minutes, seconds] => {
            Some(minutes.parse::<u64>().ok()? * 60 + seconds.parse::<u64>().ok()?)
        }
        [hours, minutes, seconds] => Some(
            hours.parse::<u64>().ok()? * 3600
                + minutes.parse::<u64>().ok()? * 60
                + seconds.parse::<u64>().ok()?,
        ),
        _ => None,
    }
}

fn optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("NA"))
        .map(str::to_owned)
}

fn required_string(value: &Value, key: &str) -> Result<String, AppError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::DownloadFailed(format!("YouTube {key} is missing")))
}

fn last_diagnostic(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("yt-dlp failed")
        .trim()
        .to_owned()
}
