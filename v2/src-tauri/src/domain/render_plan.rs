use std::path::{Path, PathBuf};

use crate::error::AppError;

use super::{
    project::{ExportSettings, NormalizedRect, Project, SourceMetadata},
    time::{MediaTime, TimeRange},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedInput {
    pub path: PathBuf,
    pub source_offset: MediaTime,
    pub metadata: SourceMetadata,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncoderSelection {
    CpuX264,
    IntelQsv,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedCaptionCue {
    pub start: MediaTime,
    pub end: MediaTime,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedOverlay {
    pub id: String,
    pub spans: Vec<TimeRange>,
    pub geometry: NormalizedRect,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RenderPlan {
    input: ResolvedInput,
    keep_segments: Vec<TimeRange>,
    duration: MediaTime,
    captions: Vec<ResolvedCaptionCue>,
    overlays: Vec<ResolvedOverlay>,
    export: ExportSettings,
    output: PathBuf,
    encoder: EncoderSelection,
}

impl RenderPlan {
    pub fn input(&self) -> &ResolvedInput {
        &self.input
    }

    pub fn keep_segments(&self) -> &[TimeRange] {
        &self.keep_segments
    }

    pub fn duration(&self) -> MediaTime {
        self.duration
    }

    pub fn captions(&self) -> &[ResolvedCaptionCue] {
        &self.captions
    }

    pub fn overlays(&self) -> &[ResolvedOverlay] {
        &self.overlays
    }

    pub fn export(&self) -> ExportSettings {
        self.export
    }

    pub fn output(&self) -> &Path {
        &self.output
    }

    pub fn encoder(&self) -> EncoderSelection {
        self.encoder
    }
}

pub fn build_keep_segments(
    selection: TimeRange,
    removed: &[TimeRange],
) -> Result<Vec<TimeRange>, AppError> {
    let mut normalized = removed
        .iter()
        .filter_map(|range| intersect(*range, selection))
        .collect::<Vec<_>>();
    normalized.sort_unstable_by_key(|range| (range.start(), range.end()));

    let mut merged = Vec::<TimeRange>::with_capacity(normalized.len());
    for range in normalized {
        if let Some(last) = merged.last_mut()
            && range.start() <= last.end()
        {
            if range.end() > last.end() {
                *last = TimeRange::new(last.start().0, range.end().0)?;
            }
            continue;
        }
        merged.push(range);
    }

    let mut keep = Vec::with_capacity(merged.len() + 1);
    let mut cursor = selection.start();
    for range in merged {
        if cursor < range.start() {
            keep.push(TimeRange::new(cursor.0, range.start().0)?);
        }
        cursor = range.end();
    }
    if cursor < selection.end() {
        keep.push(TimeRange::new(cursor.0, selection.end().0)?);
    }

    Ok(keep)
}

pub fn map_source_time(keep: &[TimeRange], source: MediaTime) -> Option<MediaTime> {
    keep.first()?;
    let mut output_cursor = 0_i128;

    for segment in keep {
        if source < segment.start() {
            return None;
        }

        let segment_start = i128::from(segment.start().0);
        let segment_end = i128::from(segment.end().0);
        if source <= segment.end() {
            let mapped = output_cursor.checked_add(i128::from(source.0) - segment_start)?;
            return i64::try_from(mapped).ok().map(MediaTime);
        }

        output_cursor = output_cursor.checked_add(segment_end - segment_start)?;
    }

    None
}

pub fn compile_render_plan(
    project: &Project,
    input: ResolvedInput,
    output: PathBuf,
    encoder: EncoderSelection,
) -> Result<RenderPlan, AppError> {
    let selection = match project.selection {
        Some(selection) => selection,
        None => {
            let duration = project
                .source
                .metadata
                .as_ref()
                .map_or(input.metadata.duration, |metadata| metadata.duration);
            TimeRange::new(0, duration.0)?
        }
    };
    let keep_segments = build_keep_segments(selection, &project.silence.accepted_removed_regions)?;
    if keep_segments.is_empty() {
        return Err(AppError::InvalidInput(
            "selection cannot be fully removed".into(),
        ));
    }

    let duration = duration_of(&keep_segments)?;
    let captions = if project.captions.enabled {
        resolve_captions(project, &keep_segments)?
    } else {
        Vec::new()
    };
    let overlays = resolve_overlays(project, &keep_segments)?;

    Ok(RenderPlan {
        input,
        keep_segments,
        duration,
        captions,
        overlays,
        export: project.export,
        output,
        encoder,
    })
}

fn resolve_captions(
    project: &Project,
    keep: &[TimeRange],
) -> Result<Vec<ResolvedCaptionCue>, AppError> {
    let mut resolved = Vec::new();
    for cue in &project.captions.cues {
        let source_range = TimeRange::new(cue.start.0, cue.end.0)?;
        for span in map_source_range(keep, source_range)? {
            resolved.push(ResolvedCaptionCue {
                start: span.start(),
                end: span.end(),
                text: cue.text.clone(),
            });
        }
    }
    Ok(resolved)
}

fn resolve_overlays(
    project: &Project,
    keep: &[TimeRange],
) -> Result<Vec<ResolvedOverlay>, AppError> {
    let mut resolved = Vec::new();
    for overlay in &project.overlays {
        let spans = map_source_range(keep, overlay.range)?;
        if !spans.is_empty() {
            resolved.push(ResolvedOverlay {
                id: overlay.id.clone(),
                spans,
                geometry: overlay.geometry,
            });
        }
    }
    Ok(resolved)
}

fn map_source_range(keep: &[TimeRange], source: TimeRange) -> Result<Vec<TimeRange>, AppError> {
    let mut mapped = Vec::new();
    for segment in keep {
        let Some(clipped) = intersect(source, *segment) else {
            continue;
        };
        let Some(start) = map_source_time(keep, clipped.start()) else {
            continue;
        };
        let duration = i128::from(clipped.end().0) - i128::from(clipped.start().0);
        let end = i128::from(start.0)
            .checked_add(duration)
            .and_then(|value| i64::try_from(value).ok())
            .ok_or_else(|| {
                AppError::InvalidInput("mapped time is outside the supported range".into())
            })?;
        mapped.push(TimeRange::new(start.0, end)?);
    }
    Ok(mapped)
}

fn intersect(left: TimeRange, right: TimeRange) -> Option<TimeRange> {
    let start = left.start().max(right.start());
    let end = left.end().min(right.end());
    (start < end).then(|| TimeRange::new(start.0, end.0).expect("intersection is non-empty"))
}

fn duration_of(ranges: &[TimeRange]) -> Result<MediaTime, AppError> {
    let duration = ranges.iter().try_fold(0_i128, |total, range| {
        total.checked_add(i128::from(range.end().0) - i128::from(range.start().0))
    });
    let duration = duration
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| {
            AppError::InvalidInput("render duration is outside the supported range".into())
        })?;
    Ok(MediaTime(duration))
}
