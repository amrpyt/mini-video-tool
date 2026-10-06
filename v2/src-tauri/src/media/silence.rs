use std::{ffi::OsString, fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_shell::{ShellExt, process::CommandEvent};

use crate::{
    domain::time::{MediaTime, TimeRange},
    error::AppError,
    jobs::{JobKind, JobManager, JobOutcome, JobProgress, JobStatus},
};

const SILENCE_MARGIN_US: i64 = 200_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSilenceRequest {
    pub source: PathBuf,
    pub selection: TimeRange,
    pub source_offset: MediaTime,
    pub local_duration: MediaTime,
    pub has_audio: bool,
    pub waveform_destination: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceAnalysis {
    pub detected_regions: Vec<TimeRange>,
    pub waveform_image: Option<PathBuf>,
}

pub fn validate_analysis_request(request: &AnalyzeSilenceRequest) -> Result<(), AppError> {
    if !request.has_audio {
        return Err(AppError::UnsupportedMedia(
            "source has no audio track; silence analysis is unavailable".into(),
        ));
    }
    if request.source_offset.0 < 0 || request.local_duration.0 <= 0 {
        return Err(AppError::InvalidInput(
            "resolved local media timing is invalid".into(),
        ));
    }

    let local_start = request.selection.start().0 - request.source_offset.0;
    let local_end = request.selection.end().0 - request.source_offset.0;
    if local_start < 0 || local_end > request.local_duration.0 {
        return Err(AppError::InvalidInput(
            "selected source range is outside the resolved local media".into(),
        ));
    }
    Ok(())
}

pub fn build_analysis_args(request: &AnalyzeSilenceRequest) -> Result<Vec<OsString>, AppError> {
    validate_analysis_request(request)?;
    let local_start = MediaTime(request.selection.start().0 - request.source_offset.0);
    let duration = MediaTime(request.selection.end().0 - request.selection.start().0);
    let graph = concat!(
        "[0:a]asetpts=PTS-STARTPTS,asplit=2[detectin][wavein];",
        "[detectin]silencedetect=noise=-35dB:d=0.6[detected];",
        "[wavein]showwavespic=s=1200x160:colors=white[wave]"
    );

    Ok(vec![
        "-y".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-ss".into(),
        seconds_arg(local_start).into(),
        "-t".into(),
        seconds_arg(duration).into(),
        "-i".into(),
        request.source.as_os_str().to_owned(),
        "-filter_complex".into(),
        graph.into(),
        "-map".into(),
        "[detected]".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
        "-map".into(),
        "[wave]".into(),
        "-frames:v".into(),
        "1".into(),
        "-update".into(),
        "1".into(),
        request.waveform_destination.as_os_str().to_owned(),
    ])
}

pub fn parse_silence_regions(
    stderr: &str,
    analysis_duration_us: i64,
    source_start_us: i64,
) -> Result<Vec<TimeRange>, AppError> {
    if analysis_duration_us <= 0 {
        return Err(AppError::InvalidInput(
            "analysis duration must be positive".into(),
        ));
    }

    let mut pending_start = None;
    let mut raw_regions = Vec::new();
    for line in stderr.lines() {
        if let Some(value) = marker_value(line, "silence_start:") {
            pending_start = Some(parse_seconds_us(value)?);
        }
        if let Some(value) = marker_value(line, "silence_end:")
            && let Some(start) = pending_start.take()
        {
            let end = parse_seconds_us(value)?;
            if end > start {
                raw_regions.push((start, end));
            }
        }
    }
    if let Some(start) = pending_start
        && start < analysis_duration_us
    {
        raw_regions.push((start, analysis_duration_us));
    }

    let mut regions = Vec::new();
    for (start, end) in raw_regions {
        let cut_start = start.saturating_add(SILENCE_MARGIN_US).max(0);
        let cut_end = end
            .saturating_sub(SILENCE_MARGIN_US)
            .min(analysis_duration_us);
        if cut_end <= cut_start {
            continue;
        }
        regions.push(TimeRange::new(
            source_start_us.saturating_add(cut_start),
            source_start_us.saturating_add(cut_end),
        )?);
    }
    Ok(regions)
}

pub async fn analyze_silence(
    app: &AppHandle,
    manager: &JobManager,
    request: &AnalyzeSilenceRequest,
) -> Result<SilenceAnalysis, AppError> {
    validate_analysis_request(request)?;
    if let Some(parent) = request.waveform_destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::AnalysisFailed(format!(
                "cannot create waveform directory {}: {error}",
                parent.display()
            ))
        })?;
    }

    let args = build_analysis_args(request)?;
    let job = manager.begin(JobKind::SilenceAnalysis)?;
    let command = match app.shell().sidecar("ffmpeg") {
        Ok(command) => command.args(args),
        Err(error) => {
            manager.finish(job, JobOutcome::Failed)?;
            return Err(AppError::AnalysisFailed(error.to_string()));
        }
    };
    let (mut receiver, child) = match command.spawn() {
        Ok(spawned) => spawned,
        Err(error) => {
            manager.finish(job, JobOutcome::Failed)?;
            return Err(AppError::AnalysisFailed(error.to_string()));
        }
    };
    manager.attach_process(job, child.pid())?;

    let analysis_duration_us = request.selection.end().0 - request.selection.start().0;
    let mut stderr = String::new();
    let mut exit_code = None;
    let mut process_error = None;
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                if let Some(progress) = parse_progress(&chunk, analysis_duration_us) {
                    manager.update_progress(job, progress)?;
                }
            }
            CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
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
        return Err(AppError::AnalysisFailed(
            process_error.unwrap_or_else(|| last_diagnostic(&stderr, exit_code)),
        ));
    }
    if !request.waveform_destination.is_file() {
        manager.finish(job, JobOutcome::Failed)?;
        return Err(AppError::AnalysisFailed(
            "ffmpeg completed without producing the waveform image".into(),
        ));
    }

    let detected_regions =
        match parse_silence_regions(&stderr, analysis_duration_us, request.selection.start().0) {
            Ok(regions) => regions,
            Err(error) => {
                manager.finish(job, JobOutcome::Failed)?;
                return Err(error);
            }
        };
    manager.update_progress(
        job,
        JobProgress {
            stage: "silence_analysis".into(),
            fraction: Some(1.0),
            speed: None,
            eta_seconds: None,
            message: "silence analysis completed".into(),
        },
    )?;
    manager.finish(job, JobOutcome::Completed)?;

    Ok(SilenceAnalysis {
        detected_regions,
        waveform_image: Some(request.waveform_destination.clone()),
    })
}

fn parse_progress(chunk: &str, duration_us: i64) -> Option<JobProgress> {
    let out_time = chunk.lines().find_map(|line| {
        line.trim()
            .strip_prefix("out_time_us=")
            .and_then(|value| value.parse::<i64>().ok())
    })?;
    let fraction = if duration_us > 0 {
        Some((out_time as f64 / duration_us as f64).clamp(0.0, 1.0))
    } else {
        None
    };
    Some(JobProgress {
        stage: "silence_analysis".into(),
        fraction,
        speed: None,
        eta_seconds: None,
        message: "analyzing silence".into(),
    })
}

fn marker_value<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    let value = line.split_once(marker)?.1.trim_start();
    Some(value.split_whitespace().next().unwrap_or(""))
}

fn parse_seconds_us(value: &str) -> Result<i64, AppError> {
    if value.starts_with('-') {
        return Err(AppError::AnalysisFailed(
            "silence detector emitted a negative timestamp".into(),
        ));
    }
    let (whole_text, fraction_text) = value.split_once('.').unwrap_or((value, ""));
    let whole = whole_text
        .parse::<i64>()
        .map_err(|_| AppError::AnalysisFailed(format!("invalid silence timestamp: {value}")))?;
    if !fraction_text
        .chars()
        .all(|character| character.is_ascii_digit())
    {
        return Err(AppError::AnalysisFailed(format!(
            "invalid silence timestamp: {value}"
        )));
    }
    let mut micros_text = fraction_text.chars().take(6).collect::<String>();
    while micros_text.len() < 6 {
        micros_text.push('0');
    }
    let mut micros = if micros_text.is_empty() {
        0
    } else {
        micros_text
            .parse::<i64>()
            .map_err(|_| AppError::AnalysisFailed(format!("invalid silence timestamp: {value}")))?
    };
    if fraction_text
        .as_bytes()
        .get(6)
        .is_some_and(|digit| *digit >= b'5')
    {
        micros += 1;
    }
    whole
        .checked_mul(1_000_000)
        .and_then(|base| base.checked_add(micros))
        .ok_or_else(|| AppError::AnalysisFailed("silence timestamp overflow".into()))
}

fn seconds_arg(time: MediaTime) -> String {
    format!(
        "{}.{:06}",
        time.0 / 1_000_000,
        time.0.unsigned_abs() % 1_000_000
    )
}

fn last_diagnostic(stderr: &str, exit_code: Option<i32>) -> String {
    stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("ffmpeg silence analysis exited with code {exit_code:?}"))
}
