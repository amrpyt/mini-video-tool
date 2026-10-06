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
            commands::source::probe_source,
            commands::source::youtube_metadata,
            commands::source::download_range,
            commands::source::extract_preview_frame,
            commands::source::extract_filmstrip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mini Video Tool v2");
}
