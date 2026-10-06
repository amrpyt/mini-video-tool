use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::{
    domain::project::CaptionTrack,
    error::AppError,
    jobs::JobManager,
    media::captions,
};

#[tauri::command]
pub async fn import_captions(path: PathBuf) -> Result<CaptionTrack, AppError> {
    captions::import_captions(&path)
}

#[tauri::command]
pub async fn youtube_captions(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    url: String,
) -> Result<CaptionTrack, AppError> {
    captions::youtube_captions(&app, jobs.inner(), &url).await
}
