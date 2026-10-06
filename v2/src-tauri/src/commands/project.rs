use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    domain::project::Project,
    error::AppError,
    project_io::{load_project as read_project, save_project_atomic},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceAvailability {
    Available,
    Unavailable { message: String },
    NotApplicable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLoadResult {
    pub project: Project,
    pub source_availability: SourceAvailability,
}

pub fn load_project_result(path: &Path) -> Result<ProjectLoadResult, AppError> {
    let mut project = read_project(path)?;
    if project.source.url.is_some()
        && project
            .source
            .resolved_path
            .as_ref()
            .is_some_and(|resolved| !resolved.is_file())
    {
        project.source.resolved_path = None;
        project.source.source_offset = None;
        project.source.resolved_metadata = None;
    }
    let source_availability = source_availability(&project);
    Ok(ProjectLoadResult {
        project,
        source_availability,
    })
}

#[tauri::command]
pub async fn save_project(path: PathBuf, project: Project) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::ExportFailed(format!(
                "cannot create project directory {}: {error}",
                parent.display()
            ))
        })?;
    }
    save_project_atomic(&path, &project)
}

#[tauri::command]
pub async fn load_project(path: PathBuf) -> Result<ProjectLoadResult, AppError> {
    load_project_result(&path)
}

#[tauri::command]
pub async fn load_project_if_exists(path: PathBuf) -> Result<Option<ProjectLoadResult>, AppError> {
    if !path.is_file() {
        return Ok(None);
    }
    load_project_result(&path).map(Some)
}

fn source_availability(project: &Project) -> SourceAvailability {
    if let Some(path) = project.source.path.as_ref() {
        return if path.is_file() {
            SourceAvailability::Available
        } else {
            SourceAvailability::Unavailable {
                message: format!("SourceUnavailable: {}", path.display()),
            }
        };
    }

    if project
        .source
        .url
        .as_deref()
        .is_some_and(|url| !url.trim().is_empty())
    {
        return SourceAvailability::Available;
    }

    SourceAvailability::NotApplicable
}
