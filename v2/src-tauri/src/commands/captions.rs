use std::path::PathBuf;

use tauri::AppHandle;

use crate::{domain::project::CaptionTrack, error::AppError, media::captions};

#[tauri::command]
pub async fn import_captions(path: PathBuf) -> Result<CaptionTrack, AppError> {
    captions::import_captions(&path)
}

#[tauri::command]
pub async fn youtube_captions(app: AppHandle, url: String) -> Result<CaptionTrack, AppError> {
    captions::youtube_captions(&app, &url).await
}
