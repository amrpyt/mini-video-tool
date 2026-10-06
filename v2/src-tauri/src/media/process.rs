use std::ffi::OsString;

use tauri::AppHandle;
use tauri_plugin_shell::{ShellExt, process::CommandEvent};

use crate::jobs::JobManager;

#[derive(Debug)]
pub struct AuxiliaryOutput {
    pub exit_code: Option<i32>,
    pub process_error: Option<String>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl AuxiliaryOutput {
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0) && self.process_error.is_none()
    }
}

pub async fn run_auxiliary_sidecar(
    app: &AppHandle,
    manager: &JobManager,
    sidecar: &str,
    args: Vec<OsString>,
) -> Result<AuxiliaryOutput, String> {
    let command = app
        .shell()
        .sidecar(sidecar)
        .map_err(|error| error.to_string())?
        .args(args);
    let (mut receiver, child) = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.pid();
    manager
        .attach_auxiliary_process(pid)
        .map_err(|error| error.to_string())?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let mut process_error = None;
    let mut observed_exit = false;

    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.extend_from_slice(&bytes),
            CommandEvent::Stderr(bytes) => stderr.extend_from_slice(&bytes),
            CommandEvent::Error(error) => process_error = Some(error),
            CommandEvent::Terminated(payload) => {
                observed_exit = true;
                exit_code = payload.code;
                manager
                    .auxiliary_process_exited(pid)
                    .map_err(|error| error.to_string())?;
            }
            _ => {}
        }
    }

    if !observed_exit {
        manager
            .auxiliary_process_exited(pid)
            .map_err(|error| error.to_string())?;
    }

    Ok(AuxiliaryOutput {
        exit_code,
        process_error,
        stdout,
        stderr,
    })
}
