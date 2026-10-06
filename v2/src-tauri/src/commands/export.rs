use tauri::{AppHandle, State};

use crate::{
    error::AppError,
    jobs::{JobId, JobManager},
    media::export::{self, ExportProjectRequest},
};

#[tauri::command]
pub async fn export_project(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    request: ExportProjectRequest,
) -> Result<JobId, AppError> {
    export::start_export(app, jobs.inner(), request)
}
