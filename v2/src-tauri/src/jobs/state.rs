use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct JobId(pub u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobKind {
    Download,
    SilenceAnalysis,
    Export,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum JobStatus {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub(crate) fn is_busy(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Cancelling)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct JobProgress {
    pub stage: String,
    pub fraction: Option<f64>,
    pub speed: Option<String>,
    pub eta_seconds: Option<u64>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobOutcome {
    Completed,
    Failed,
    Cancelled,
}

pub(crate) struct JobRecord {
    pub(crate) kind: JobKind,
    pub(crate) status: JobStatus,
    pub(crate) progress: Option<JobProgress>,
    pub(crate) pid: Option<u32>,
}

pub(crate) struct ManagerState {
    pub(crate) next_id: u64,
    pub(crate) active: Option<JobId>,
    pub(crate) jobs: HashMap<JobId, JobRecord>,
}

impl ManagerState {
    pub(crate) fn new() -> Self {
        Self {
            next_id: 0,
            active: None,
            jobs: HashMap::new(),
        }
    }
}
