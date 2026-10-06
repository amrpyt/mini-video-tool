mod manager;
mod state;
mod windows;

pub use manager::JobManager;
pub use state::{JobId, JobKind, JobOutcome, JobProgress, JobSnapshot, JobStatus};
pub use windows::terminate_process_tree;
