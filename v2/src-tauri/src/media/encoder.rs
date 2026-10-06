use std::ffi::OsString;

use tauri::AppHandle;

use crate::{domain::render_plan::EncoderSelection, jobs::JobManager};

use super::process::run_auxiliary_sidecar;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EncoderCapabilities {
    pub qsv_h264: bool,
}

pub fn choose_encoder(
    capabilities: &EncoderCapabilities,
    width: u32,
    height: u32,
    prefer_hardware: bool,
) -> EncoderSelection {
    let pixels = u64::from(width) * u64::from(height);
    if prefer_hardware && capabilities.qsv_h264 && pixels >= 1280_u64 * 720 {
        EncoderSelection::IntelQsv
    } else {
        EncoderSelection::CpuX264
    }
}

pub fn parse_encoder_capabilities(output: &str) -> EncoderCapabilities {
    EncoderCapabilities {
        qsv_h264: output.lines().any(|line| line.contains("h264_qsv")),
    }
}

pub fn is_qsv_initialization_failure(diagnostic: &str) -> bool {
    let text = diagnostic.to_ascii_lowercase();
    let mentions_qsv = text.contains("qsv")
        || text.contains("mfx")
        || text.contains("quick sync")
        || text.contains("quick-sync");
    let mentions_initialization = text.contains("init")
        || text.contains("session")
        || text.contains("device")
        || text.contains("hardware")
        || text.contains("unsupported")
        || text.contains("opening encoder");
    mentions_qsv && mentions_initialization
}

pub async fn detect_encoder_capabilities(
    app: &AppHandle,
    manager: &JobManager,
) -> EncoderCapabilities {
    let args = vec![OsString::from("-hide_banner"), OsString::from("-encoders")];
    let Ok(output) = run_auxiliary_sidecar(app, manager, "ffmpeg", args).await else {
        return EncoderCapabilities::default();
    };
    if !output.succeeded() {
        return EncoderCapabilities::default();
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    parse_encoder_capabilities(&text)
}
