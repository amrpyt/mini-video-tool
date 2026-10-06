use std::{collections::BTreeMap, ffi::OsString};

use tauri::AppHandle;
use tauri_plugin_shell::{ShellExt, process::CommandEvent};

use crate::{
    domain::time::MediaTime,
    error::AppError,
    jobs::{JobId, JobManager},
};

use super::export::parse_ffmpeg_progress;

#[derive(Debug)]
pub struct FfmpegAttempt {
    pub exit_code: Option<i32>,
    pub process_error: Option<String>,
    pub stderr: String,
    pub max_out_time_us: i64,
}

impl FfmpegAttempt {
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0) && self.process_error.is_none()
    }

    pub fn diagnostic(&self) -> String {
        self.process_error.clone().unwrap_or_else(|| {
            self.stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(str::trim)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("ffmpeg exited with code {:?}", self.exit_code))
        })
    }
}

pub async fn run_attempt(
    app: &AppHandle,
    manager: &JobManager,
    job: JobId,
    args: Vec<OsString>,
    duration: MediaTime,
) -> Result<FfmpegAttempt, AppError> {
    let command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|error| AppError::ExportFailed(error.to_string()))?
        .args(args);
    let (mut receiver, child) = command
        .spawn()
        .map_err(|error| AppError::ExportFailed(error.to_string()))?;
    manager.attach_process(job, child.pid())?;

    let mut exit_code = None;
    let mut process_error = None;
    let mut stderr = String::new();
    let mut fields = BTreeMap::<String, String>::new();
    let mut max_out_time_us = 0_i64;

    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                for line in chunk.lines() {
                    if let Some((key, value)) = line.trim().split_once('=') {
                        fields.insert(key.to_owned(), value.to_owned());
                        if key == "out_time_us"
                            && let Ok(value) = value.parse::<i64>()
                        {
                            max_out_time_us = max_out_time_us.max(value);
                        }
                        if key == "progress" {
                            manager
                                .update_progress(job, parse_ffmpeg_progress(&fields, duration))?;
                            fields.clear();
                        }
                    }
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

    Ok(FfmpegAttempt {
        exit_code,
        process_error,
        stderr,
        max_out_time_us,
    })
}
