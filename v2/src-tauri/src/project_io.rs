use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use crate::{
    domain::project::{PROJECT_SCHEMA_VERSION, Project},
    error::AppError,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

pub fn save_project_atomic(path: &Path, project: &Project) -> Result<(), AppError> {
    validate_schema_version(project)?;
    let (temp_path, temp_file) = create_sibling_temp(path)?;
    let result = write_project(temp_file, &temp_path, project)
        .and_then(|_| atomic_replace_file(&temp_path, path));

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result
}

pub fn load_project(path: &Path) -> Result<Project, AppError> {
    let file = File::open(path)
        .map_err(|error| AppError::SourceUnavailable(format!("{}: {error}", path.display())))?;

    let project = serde_json::from_reader(BufReader::new(file)).map_err(|error| {
        AppError::InvalidInput(format!("invalid project file {}: {error}", path.display()))
    })?;
    validate_schema_version(&project)?;
    Ok(project)
}

fn validate_schema_version(project: &Project) -> Result<(), AppError> {
    if project.schema_version != PROJECT_SCHEMA_VERSION {
        return Err(AppError::InvalidInput(format!(
            "unsupported project schema version {}; expected {}",
            project.schema_version, PROJECT_SCHEMA_VERSION
        )));
    }

    Ok(())
}

fn create_sibling_temp(destination: &Path) -> Result<(PathBuf, File), AppError> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput("project path must have a valid file name".into()))?;

    for _ in 0..100 {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), id));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(AppError::ExportFailed(format!(
                    "cannot create project temp file {}: {error}",
                    temp_path.display()
                )));
            }
        }
    }

    Err(AppError::ExportFailed(
        "could not allocate a unique project temp file".into(),
    ))
}

fn write_project(file: File, temp_path: &Path, project: &Project) -> Result<(), AppError> {
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, project).map_err(|error| {
        AppError::ExportFailed(format!(
            "cannot serialize project to {}: {error}",
            temp_path.display()
        ))
    })?;
    writer.write_all(b"\n").map_err(|error| {
        AppError::ExportFailed(format!(
            "cannot finish project temp file {}: {error}",
            temp_path.display()
        ))
    })?;
    writer.flush().map_err(|error| {
        AppError::ExportFailed(format!(
            "cannot flush project temp file {}: {error}",
            temp_path.display()
        ))
    })?;
    writer.get_ref().sync_all().map_err(|error| {
        AppError::ExportFailed(format!(
            "cannot sync project temp file {}: {error}",
            temp_path.display()
        ))
    })
}

#[cfg(windows)]
pub fn atomic_replace_file(temp: &Path, destination: &Path) -> Result<(), AppError> {
    use std::{iter::once, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let temp_wide: Vec<u16> = temp.as_os_str().encode_wide().chain(once(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;

    let moved = unsafe { MoveFileExW(temp_wide.as_ptr(), destination_wide.as_ptr(), flags) };
    if moved == 0 {
        return Err(AppError::ExportFailed(format!(
            "cannot atomically replace {} with {}: {}",
            destination.display(),
            temp.display(),
            io::Error::last_os_error()
        )));
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn atomic_replace_file(temp: &Path, destination: &Path) -> Result<(), AppError> {
    fs::rename(temp, destination).map_err(|error| {
        AppError::ExportFailed(format!(
            "cannot atomically replace {} with {}: {error}",
            destination.display(),
            temp.display()
        ))
    })
}
