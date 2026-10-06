use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::{
    domain::project::SourceMetadata,
    error::AppError,
    jobs::JobManager,
    media::{
        ffprobe,
        preview::{self, FilmstripRequest, PreviewFrameRequest},
        ytdlp::{self, DownloadRangeRequest, ResolvedDownload, YouTubeMetadata},
    },
};

#[tauri::command]
pub async fn probe_source(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    path: PathBuf,
) -> Result<SourceMetadata, AppError> {
    ffprobe::probe_source(&app, jobs.inner(), &path).await
}

#[tauri::command]
pub async fn youtube_metadata(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    url: String,
) -> Result<YouTubeMetadata, AppError> {
    ytdlp::youtube_metadata(&app, jobs.inner(), &url).await
}

#[tauri::command]
pub async fn download_range(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    request: DownloadRangeRequest,
) -> Result<ResolvedDownload, AppError> {
    ytdlp::download_range(&app, jobs.inner(), &request).await
}

#[tauri::command]
pub async fn extract_preview_frame(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    request: PreviewFrameRequest,
) -> Result<PathBuf, AppError> {
    preview::extract_preview_frame(&app, jobs.inner(), &request).await
}

#[tauri::command]
pub async fn extract_filmstrip(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    request: FilmstripRequest,
) -> Result<Vec<PathBuf>, AppError> {
    preview::extract_filmstrip(&app, jobs.inner(), &request).await
}
