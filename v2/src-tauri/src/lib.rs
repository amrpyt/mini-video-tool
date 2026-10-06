pub mod commands;
pub mod domain;
pub mod error;
pub mod jobs;
pub mod media;
pub mod project_io;

use jobs::JobManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(JobManager::new())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::analysis::analyze_silence,
            commands::captions::import_captions,
            commands::captions::youtube_captions,
            commands::export::export_project,
            commands::jobs::latest_job,
            commands::jobs::cancel_job,
            commands::project::save_project,
            commands::project::load_project,
            commands::project::load_project_if_exists,
            commands::source::probe_source,
            commands::source::youtube_metadata,
            commands::source::download_range,
            commands::source::extract_preview_frame,
            commands::source::extract_filmstrip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mini Video Tool v2");
}
