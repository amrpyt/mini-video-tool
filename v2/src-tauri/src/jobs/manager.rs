use std::{
    io,
    sync::{Arc, Mutex, MutexGuard},
};

use crate::error::AppError;

use super::{
    state::{
        JobId, JobKind, JobOutcome, JobProgress, JobRecord, JobSnapshot, JobStatus, ManagerState,
    },
    windows::terminate_process_tree,
};

type Terminator = dyn Fn(u32) -> io::Result<()> + Send + Sync;

pub struct JobManager {
    state: Mutex<ManagerState>,
    terminate: Arc<Terminator>,
}

impl Default for JobManager {
    fn default() -> Self {
        Self::new()
    }
}

impl JobManager {
    pub fn new() -> Self {
        Self::with_terminator(terminate_process_tree)
    }

    #[doc(hidden)]
    pub fn with_terminator<F>(terminate: F) -> Self
    where
        F: Fn(u32) -> io::Result<()> + Send + Sync + 'static,
    {
        Self {
            state: Mutex::new(ManagerState::new()),
            terminate: Arc::new(terminate),
        }
    }

    pub fn begin(&self, kind: JobKind) -> Result<JobId, AppError> {
        let mut state = self.lock_state()?;
        if let Some(active) = state.active {
            let active_is_busy = state
                .jobs
                .get(&active)
                .is_some_and(|record| record.status.is_busy());
            if active_is_busy {
                return Err(AppError::InvalidInput(
                    "another heavy job is already active".into(),
                ));
            }
            state.active = None;
        }

        let next_id = state
            .next_id
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidInput("job id space exhausted".into()))?;
        state.next_id = next_id;
        let job = JobId(next_id);
        state.jobs.insert(
            job,
            JobRecord {
                kind,
                status: JobStatus::Running,
                progress: None,
                pid: None,
            },
        );
        state.active = Some(job);
        Ok(job)
    }

    pub fn attach_process(&self, job: JobId, pid: u32) -> Result<(), AppError> {
        let kind = {
            let mut state = self.lock_state()?;
            let is_active = state.active == Some(job);
            let record = state
                .jobs
                .get_mut(&job)
                .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))?;

            match record.status {
                JobStatus::Queued | JobStatus::Running if is_active => {
                    if record.pid.is_some() {
                        return Err(AppError::InvalidInput(
                            "job already has an attached process".into(),
                        ));
                    }
                    record.pid = Some(pid);
                    return Ok(());
                }
                JobStatus::Cancelling | JobStatus::Cancelled => record.kind,
                _ => {
                    return Err(AppError::InvalidInput(
                        "process cannot be attached to an inactive job".into(),
                    ));
                }
            }
        };

        (self.terminate)(pid).map_err(|error| termination_error(kind, pid, error))?;
        Err(AppError::Cancelled)
    }

    pub fn cancel_active(&self) -> Result<(), AppError> {
        let job = {
            let state = self.lock_state()?;
            state
                .active
                .ok_or_else(|| AppError::InvalidInput("there is no active job".into()))?
        };
        self.cancel(job)
    }

    pub fn cancel(&self, requested_job: JobId) -> Result<(), AppError> {
        let (job, kind, pid) = {
            let mut state = self.lock_state()?;
            let job = state
                .active
                .ok_or_else(|| AppError::InvalidInput("there is no active job".into()))?;
            if job != requested_job {
                return Err(AppError::InvalidInput(
                    "requested job is no longer the active operation".into(),
                ));
            }
            let record = state
                .jobs
                .get_mut(&job)
                .ok_or_else(|| AppError::InvalidInput("active job is missing".into()))?;

            match record.status {
                JobStatus::Queued | JobStatus::Running => {
                    record.status = JobStatus::Cancelling;
                }
                JobStatus::Cancelling if record.pid.is_none() => return Ok(()),
                JobStatus::Cancelling => {}
                _ => {
                    state.active = None;
                    return Err(AppError::InvalidInput("there is no active job".into()));
                }
            }

            (job, record.kind, record.pid.take())
        };

        if let Some(pid) = pid
            && let Err(error) = (self.terminate)(pid)
        {
            let mut state = self.lock_state()?;
            let mut restored = false;
            if let Some(record) = state.jobs.get_mut(&job)
                && record.status == JobStatus::Cancelling
                && record.pid.is_none()
            {
                record.pid = Some(pid);
                restored = true;
            }
            if restored {
                return Err(termination_error(kind, pid, error));
            }
            return Ok(());
        }

        let mut state = self.lock_state()?;
        if let Some(record) = state.jobs.get_mut(&job)
            && record.status == JobStatus::Cancelling
        {
            record.status = JobStatus::Cancelled;
            record.pid = None;
        }
        if state.active == Some(job) {
            state.active = None;
        }
        Ok(())
    }

    pub fn process_exited(&self, job: JobId) -> Result<(), AppError> {
        let mut state = self.lock_state()?;
        let cancelled = {
            let record = state
                .jobs
                .get_mut(&job)
                .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))?;
            record.pid = None;
            if record.status == JobStatus::Cancelling {
                record.status = JobStatus::Cancelled;
                true
            } else {
                false
            }
        };

        if cancelled && state.active == Some(job) {
            state.active = None;
        }
        Ok(())
    }

    pub fn finish(&self, job: JobId, outcome: JobOutcome) -> Result<(), AppError> {
        let mut state = self.lock_state()?;
        let is_busy = {
            let record = state
                .jobs
                .get_mut(&job)
                .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))?;

            match record.status {
                JobStatus::Cancelling => return Ok(()),
                JobStatus::Cancelled => {
                    record.status = JobStatus::Cancelled;
                }
                JobStatus::Queued | JobStatus::Running => {
                    record.status = match outcome {
                        JobOutcome::Completed => JobStatus::Completed,
                        JobOutcome::Failed => JobStatus::Failed,
                        JobOutcome::Cancelled => JobStatus::Cancelled,
                    };
                }
                JobStatus::Completed | JobStatus::Failed => {}
            }
            record.pid = None;
            record.status.is_busy()
        };

        if state.active == Some(job) && !is_busy {
            state.active = None;
        }
        Ok(())
    }

    pub fn complete_with<F>(&self, job: JobId, finalize: F) -> Result<(), AppError>
    where
        F: FnOnce() -> Result<(), AppError>,
    {
        let mut state = self.lock_state()?;
        let is_active = state.active == Some(job);
        {
            let record = state
                .jobs
                .get(&job)
                .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))?;
            match record.status {
                JobStatus::Cancelling | JobStatus::Cancelled => return Err(AppError::Cancelled),
                JobStatus::Queued | JobStatus::Running if is_active && record.pid.is_none() => {}
                JobStatus::Completed => return Ok(()),
                JobStatus::Failed => {
                    return Err(AppError::InvalidInput(
                        "failed job cannot publish a result".into(),
                    ));
                }
                JobStatus::Queued | JobStatus::Running => {
                    return Err(AppError::InvalidInput(
                        "job cannot publish while a process is attached or inactive".into(),
                    ));
                }
            }
        }

        finalize()?;

        let record = state
            .jobs
            .get_mut(&job)
            .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))?;
        record.status = JobStatus::Completed;
        record.pid = None;
        if state.active == Some(job) {
            state.active = None;
        }
        Ok(())
    }

    pub fn status(&self, job: JobId) -> Result<JobStatus, AppError> {
        let state = self.lock_state()?;
        state
            .jobs
            .get(&job)
            .map(|record| record.status)
            .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))
    }

    pub fn update_progress(&self, job: JobId, progress: JobProgress) -> Result<(), AppError> {
        let mut state = self.lock_state()?;
        let record = state
            .jobs
            .get_mut(&job)
            .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))?;
        record.progress = Some(progress);
        Ok(())
    }

    pub fn progress(&self, job: JobId) -> Result<Option<JobProgress>, AppError> {
        let state = self.lock_state()?;
        state
            .jobs
            .get(&job)
            .map(|record| record.progress.clone())
            .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))
    }

    pub fn snapshot(&self, job: JobId) -> Result<JobSnapshot, AppError> {
        let state = self.lock_state()?;
        let record = state
            .jobs
            .get(&job)
            .ok_or_else(|| AppError::InvalidInput("unknown job id".into()))?;
        Ok(JobSnapshot {
            id: job,
            kind: record.kind,
            status: record.status,
            progress: record.progress.clone(),
        })
    }

    pub fn latest_snapshot(&self) -> Result<Option<JobSnapshot>, AppError> {
        let state = self.lock_state()?;
        if state.next_id == 0 {
            return Ok(None);
        }
        let job = JobId(state.next_id);
        Ok(state.jobs.get(&job).map(|record| JobSnapshot {
            id: job,
            kind: record.kind,
            status: record.status,
            progress: record.progress.clone(),
        }))
    }

    pub fn attach_auxiliary_process(&self, pid: u32) -> Result<(), AppError> {
        let mut state = self.lock_state()?;
        if !state.auxiliary_pids.insert(pid) {
            return Err(AppError::InvalidInput(
                "auxiliary process is already registered".into(),
            ));
        }
        Ok(())
    }

    pub fn auxiliary_process_exited(&self, pid: u32) -> Result<(), AppError> {
        let mut state = self.lock_state()?;
        state.auxiliary_pids.remove(&pid);
        Ok(())
    }

    #[doc(hidden)]
    pub fn auxiliary_process_count(&self) -> Result<usize, AppError> {
        Ok(self.lock_state()?.auxiliary_pids.len())
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, ManagerState>, AppError> {
        self.state
            .lock()
            .map_err(|_| AppError::InvalidInput("job state lock was poisoned".into()))
    }
}

impl Drop for JobManager {
    fn drop(&mut self) {
        let state = match self.state.get_mut() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut pids = state.auxiliary_pids.drain().collect::<Vec<_>>();
        pids.extend(
            state
                .jobs
                .values_mut()
                .filter_map(|record| record.pid.take()),
        );
        for pid in pids {
            let _ = (self.terminate)(pid);
        }
    }
}

fn termination_error(kind: JobKind, pid: u32, error: io::Error) -> AppError {
    let message = format!("failed to terminate process {pid}: {error}");
    match kind {
        JobKind::Download => AppError::DownloadFailed(message),
        JobKind::SilenceAnalysis => AppError::AnalysisFailed(message),
        JobKind::Export => AppError::ExportFailed(message),
    }
}
