use tauri::State;

use crate::{
    error::AppError,
    jobs::{JobId, JobManager, JobSnapshot},
};

#[tauri::command]
pub async fn latest_job(jobs: State<'_, JobManager>) -> Result<Option<JobSnapshot>, AppError> {
    jobs.latest_snapshot()
}

#[tauri::command]
pub async fn cancel_job(jobs: State<'_, JobManager>, job: JobId) -> Result<JobSnapshot, AppError> {
    jobs.cancel(job)?;
    jobs.snapshot(job)
}
