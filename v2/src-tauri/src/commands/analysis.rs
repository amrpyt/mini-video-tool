use tauri::{AppHandle, State};

use crate::{
    error::AppError,
    jobs::JobManager,
    media::silence::{self, AnalyzeSilenceRequest, SilenceAnalysis},
};

#[tauri::command]
pub async fn analyze_silence(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    request: AnalyzeSilenceRequest,
) -> Result<SilenceAnalysis, AppError> {
    silence::analyze_silence(&app, jobs.inner(), &request).await
}
