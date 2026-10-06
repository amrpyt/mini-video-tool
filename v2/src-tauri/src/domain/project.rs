use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::time::{FrameRate, MediaTime, TimeRange};

pub const PROJECT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadQuality {
    #[default]
    Best,
    P1080,
    P720,
    P480,
    P360,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceState {
    pub path: Option<PathBuf>,
    pub metadata: Option<SourceMetadata>,
    pub download_quality: DownloadQuality,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub duration: MediaTime,
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceState {
    pub detected_regions: Vec<TimeRange>,
    pub accepted_removed_regions: Vec<TimeRange>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub id: String,
    pub range: TimeRange,
    pub geometry: NormalizedRect,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTrack {
    pub enabled: bool,
    pub style: CaptionStyle,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStyle {
    pub font_family: Option<String>,
    pub font_size_px: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub source: SourceState,
    pub selection: Option<TimeRange>,
    pub silence: SilenceState,
    pub overlays: Vec<Overlay>,
    pub captions: CaptionTrack,
    pub export: ExportSettings,
}

pub type ProjectState = Project;
