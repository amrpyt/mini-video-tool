use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("source unavailable: {0}")]
    SourceUnavailable(String),
    #[error("media probe failed: {0}")]
    MediaProbeFailed(String),
    #[error("download failed: {0}")]
    DownloadFailed(String),
    #[error("analysis failed: {0}")]
    AnalysisFailed(String),
    #[error("export failed: {0}")]
    ExportFailed(String),
    #[error("disk full: {0}")]
    DiskFull(String),
    #[error("cancelled")]
    Cancelled,
    #[error("unsupported media: {0}")]
    UnsupportedMedia(String),
}
