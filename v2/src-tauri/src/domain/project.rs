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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub youtube_metadata: Option<YouTubeProjectMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_offset: Option<MediaTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_metadata: Option<SourceMetadata>,
    pub download_quality: DownloadQuality,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeProjectMetadata {
    pub video_id: String,
    pub title: String,
    pub duration: MediaTime,
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub qualities: Vec<DownloadQuality>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub duration: MediaTime,
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
    #[serde(default)]
    pub has_audio: bool,
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverlayKind {
    Image,
    #[default]
    BlackBar,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub id: String,
    #[serde(default)]
    pub kind: OverlayKind,
    pub range: TimeRange,
    pub geometry: NormalizedRect,
    #[serde(default = "default_overlay_opacity")]
    pub opacity: f32,
    #[serde(default)]
    pub asset_path: Option<PathBuf>,
    #[serde(default)]
    pub aspect_locked: bool,
}

fn default_overlay_opacity() -> f32 {
    1.0
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTrack {
    pub enabled: bool,
    #[serde(default)]
    pub cues: Vec<CaptionCue>,
    pub style: CaptionStyle,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionCue {
    pub start: MediaTime,
    pub end: MediaTime,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptionVerticalPosition {
    Top,
    Middle,
    #[default]
    Bottom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptionHorizontalPosition {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CaptionStyle {
    pub size_percent: f32,
    pub text_color: String,
    pub outline_color: String,
    pub outline_width: f32,
    pub shadow: f32,
    pub shadow_color: String,
    pub background_enabled: bool,
    pub background_color: String,
    pub background_opacity: f32,
    pub vertical_position: CaptionVerticalPosition,
    pub horizontal_position: CaptionHorizontalPosition,
    pub margin_percent: f32,
    pub bold: bool,
    pub italic: bool,
    pub font_path: Option<PathBuf>,
    // Legacy schema-v1 fields are retained for backward-compatible loads.
    pub font_family: Option<String>,
    pub font_size_px: Option<u32>,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        Self {
            size_percent: 4.5,
            text_color: "#ffffff".into(),
            outline_color: "#000000".into(),
            outline_width: 1.2,
            shadow: 2.0,
            shadow_color: "#000000".into(),
            background_enabled: false,
            background_color: "#000000".into(),
            background_opacity: 55.0,
            vertical_position: CaptionVerticalPosition::Bottom,
            horizontal_position: CaptionHorizontalPosition::Center,
            margin_percent: 7.0,
            bold: false,
            italic: false,
            font_path: None,
            font_family: None,
            font_size_px: None,
        }
    }
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
