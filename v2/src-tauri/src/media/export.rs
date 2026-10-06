use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    domain::{
        project::{
            CaptionHorizontalPosition, CaptionStyle, CaptionVerticalPosition, OverlayKind, Project,
        },
        render_plan::{EncoderSelection, RenderPlan, ResolvedInput, compile_render_plan},
        time::MediaTime,
    },
    error::AppError,
    jobs::{JobId, JobKind, JobManager, JobOutcome, JobProgress, JobStatus},
    project_io::atomic_replace_file,
};

use super::{encoder, ffmpeg, ffprobe};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProjectRequest {
    pub project: Project,
    pub input: ResolvedInput,
    pub output: PathBuf,
    pub prefer_hardware: bool,
}

#[derive(Clone, Debug)]
pub struct PreparedImageInput {
    pub overlay_id: String,
    pub path: PathBuf,
    pub input_index: usize,
}

#[derive(Clone, Debug, Default)]
pub struct PreparedRender {
    image_inputs: Vec<PreparedImageInput>,
    caption_ass: Option<PathBuf>,
    fonts_dir: Option<PathBuf>,
}

impl PreparedRender {
    pub fn image_inputs(&self) -> &[PreparedImageInput] {
        &self.image_inputs
    }

    pub fn caption_ass(&self) -> Option<&Path> {
        self.caption_ass.as_deref()
    }

    pub fn fonts_dir(&self) -> Option<&Path> {
        self.fonts_dir.as_deref()
    }
}

pub fn prepare_render_assets(
    plan: &RenderPlan,
    job_dir: &Path,
) -> Result<PreparedRender, AppError> {
    fs::create_dir_all(job_dir).map_err(export_io_error("create render workspace", job_dir))?;
    let mut prepared = PreparedRender::default();

    for overlay in plan.overlays() {
        if overlay.kind != OverlayKind::Image {
            continue;
        }
        let source = overlay.asset_path.as_ref().ok_or_else(|| {
            AppError::InvalidInput(format!("image overlay {} has no asset path", overlay.id))
        })?;
        if !source.is_file() {
            return Err(AppError::SourceUnavailable(format!(
                "overlay asset is missing: {}",
                source.display()
            )));
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png");
        let destination = job_dir.join(format!(
            "overlay-{}-{}.{}",
            prepared.image_inputs.len(),
            safe_name(&overlay.id),
            extension
        ));
        fs::copy(source, &destination)
            .map_err(export_io_error("copy overlay asset", &destination))?;
        prepared.image_inputs.push(PreparedImageInput {
            overlay_id: overlay.id.clone(),
            path: destination,
            input_index: prepared.image_inputs.len() + 1,
        });
    }

    if !plan.captions().is_empty() {
        let style = plan.caption_style().cloned().unwrap_or_default();
        let mut resolved_font_name = None;
        if let Some(font_path) = style.font_path.as_ref() {
            if !font_path.is_file() {
                return Err(AppError::SourceUnavailable(format!(
                    "caption font is missing: {}",
                    font_path.display()
                )));
            }
            let fonts_dir = job_dir.join("fonts");
            fs::create_dir_all(&fonts_dir)
                .map_err(export_io_error("create font workspace", &fonts_dir))?;
            let file_name = font_path.file_name().ok_or_else(|| {
                AppError::InvalidInput("caption font path has no file name".into())
            })?;
            fs::copy(font_path, fonts_dir.join(file_name))
                .map_err(export_io_error("copy caption font", &fonts_dir))?;
            resolved_font_name = Some(read_font_family(font_path)?);
            prepared.fonts_dir = Some(fonts_dir);
        }

        let ass_path = job_dir.join("captions.ass");
        fs::write(
            &ass_path,
            render_ass(plan, &style, resolved_font_name.as_deref()),
        )
        .map_err(export_io_error("write caption asset", &ass_path))?;
        prepared.caption_ass = Some(ass_path);
    }

    Ok(prepared)
}

pub fn build_filter_graph(
    plan: &RenderPlan,
    prepared: &PreparedRender,
) -> Result<String, AppError> {
    if plan.keep_segments().is_empty() {
        return Err(AppError::InvalidInput(
            "render plan has no kept video".into(),
        ));
    }
    let export = plan.export();
    let source_offset = plan.input().source_offset.0;
    let local_duration = plan.input().metadata.duration.0;
    let has_audio = plan.input().metadata.has_audio;
    let mut graph = String::new();

    for (index, segment) in plan.keep_segments().iter().enumerate() {
        let start = segment.start().0 - source_offset;
        let end = segment.end().0 - source_offset;
        if start < 0 || end <= start || end > local_duration {
            return Err(AppError::InvalidInput(
                "render range is outside the resolved local media".into(),
            ));
        }
        graph.push_str(&format!(
            "[0:v]trim=start={}:end={},setpts=PTS-STARTPTS[vseg{index}];",
            seconds(start),
            seconds(end)
        ));
        if has_audio {
            graph.push_str(&format!(
                "[0:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[aseg{index}];",
                seconds(start),
                seconds(end)
            ));
        }
    }

    if plan.keep_segments().len() == 1 {
        graph.push_str("[vseg0]null[vconcat];");
        if has_audio {
            graph.push_str("[aseg0]anull[aout];");
        }
    } else if has_audio {
        for index in 0..plan.keep_segments().len() {
            graph.push_str(&format!("[vseg{index}][aseg{index}]"));
        }
        graph.push_str(&format!(
            "concat=n={}:v=1:a=1[vconcat][aout];",
            plan.keep_segments().len()
        ));
    } else {
        for index in 0..plan.keep_segments().len() {
            graph.push_str(&format!("[vseg{index}]"));
        }
        graph.push_str(&format!(
            "concat=n={}:v=1:a=0[vconcat];",
            plan.keep_segments().len()
        ));
    }

    graph.push_str(&format!(
        "[vconcat]scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={}/{}[vbase];",
        export.width,
        export.height,
        export.width,
        export.height,
        export.frame_rate.numerator,
        export.frame_rate.denominator
    ));

    let mut current_video = "vbase".to_owned();
    for (stage, overlay) in plan.overlays().iter().enumerate() {
        let (x, y, width, height) = rect_pixels(overlay.geometry, export.width, export.height)?;
        let enable = overlay_enable(overlay.spans.as_slice());
        let next = format!("vstage{stage}");
        match overlay.kind {
            OverlayKind::BlackBar => {
                graph.push_str(&format!(
                    "[{current_video}]drawbox=x={x}:y={y}:w={width}:h={height}:color=black@{:.3}:t=fill:enable='{}'[{next}];",
                    overlay.opacity.clamp(0.0, 1.0), enable
                ));
            }
            OverlayKind::Image => {
                let image = prepared
                    .image_inputs
                    .iter()
                    .find(|input| input.overlay_id == overlay.id)
                    .ok_or_else(|| {
                        AppError::InvalidInput(format!(
                            "missing prepared image overlay {}",
                            overlay.id
                        ))
                    })?;
                let prepared_label = format!("overlay{stage}");
                graph.push_str(&format!(
                    "[{}:v]scale={width}:{height},format=rgba,colorchannelmixer=aa={:.3}[{prepared_label}];",
                    image.input_index,
                    overlay.opacity.clamp(0.0, 1.0)
                ));
                graph.push_str(&format!(
                    "[{current_video}][{prepared_label}]overlay=x={x}:y={y}:enable='{enable}':shortest=1[{next}];"
                ));
            }
        }
        current_video = next;
    }

    if let Some(captions) = prepared.caption_ass() {
        let next = "vout";
        let mut filter = format!("ass=filename='{}'", filter_path(captions));
        if let Some(fonts_dir) = prepared.fonts_dir() {
            filter.push_str(&format!(":fontsdir='{}'", filter_path(fonts_dir)));
        }
        graph.push_str(&format!("[{current_video}]{filter}[{next}]"));
    } else {
        graph.push_str(&format!("[{current_video}]null[vout]"));
    }
    Ok(graph)
}

pub fn build_ffmpeg_args(
    plan: &RenderPlan,
    prepared: &PreparedRender,
    filter_file: &Path,
    temp_output: &Path,
) -> Vec<OsString> {
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-i".into(),
        plan.input().path.as_os_str().to_owned(),
    ];
    for image in prepared.image_inputs() {
        args.extend([
            OsString::from("-loop"),
            OsString::from("1"),
            OsString::from("-framerate"),
            OsString::from("1"),
            OsString::from("-i"),
            image.path.as_os_str().to_owned(),
        ]);
    }
    args.extend([
        "-/filter_complex".into(),
        filter_file.as_os_str().to_owned(),
        "-map".into(),
        "[vout]".into(),
    ]);
    if plan.input().metadata.has_audio {
        args.extend(["-map".into(), "[aout]".into()]);
    }
    args.push("-c:v".into());
    match plan.encoder() {
        EncoderSelection::CpuX264 => args.extend([
            OsString::from("libx264"),
            OsString::from("-crf"),
            OsString::from("20"),
            OsString::from("-preset"),
            OsString::from("medium"),
        ]),
        EncoderSelection::IntelQsv => args.extend([
            OsString::from("h264_qsv"),
            OsString::from("-global_quality"),
            OsString::from("23"),
        ]),
    }
    args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    if plan.input().metadata.has_audio {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        temp_output.as_os_str().to_owned(),
    ]);
    args
}

pub fn parse_ffmpeg_progress(
    fields: &BTreeMap<String, String>,
    duration: MediaTime,
) -> JobProgress {
    let finished = fields.get("progress").is_some_and(|value| value == "end");
    let out_time = fields
        .get("out_time_us")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 0);
    let fraction = if finished {
        Some(1.0)
    } else {
        out_time.and_then(|value| {
            (duration.0 > 0).then_some((value as f64 / duration.0 as f64).clamp(0.0, 1.0))
        })
    };
    let speed = fields
        .get("speed")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != "N/A")
        .map(ToOwned::to_owned);
    let speed_factor = speed
        .as_deref()
        .and_then(|value| value.trim_end_matches('x').parse::<f64>().ok())
        .filter(|value| *value > 0.0);
    let eta_seconds = if finished {
        Some(0)
    } else {
        match (out_time, speed_factor) {
            (Some(out_time), Some(speed)) if duration.0 > 0 => {
                let remaining = duration.0.saturating_sub(out_time).max(0) as f64 / 1_000_000.0;
                Some((remaining / speed).ceil() as u64)
            }
            _ => None,
        }
    };
    JobProgress {
        stage: "export".into(),
        fraction,
        speed,
        eta_seconds,
        message: fraction
            .map(|value| format!("Exporting {:.1}%", value * 100.0))
            .unwrap_or_else(|| "Exporting".into()),
    }
}

pub fn publish_temp_output(
    temp_output: &Path,
    destination: &Path,
    cancelled: bool,
) -> Result<(), AppError> {
    if cancelled {
        let _ = fs::remove_file(temp_output);
        return Err(AppError::Cancelled);
    }
    let valid = temp_output
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if !valid {
        let _ = fs::remove_file(temp_output);
        return Err(AppError::ExportFailed(
            "temporary export output is missing or empty".into(),
        ));
    }
    if let Err(error) = atomic_replace_file(temp_output, destination) {
        let _ = fs::remove_file(temp_output);
        return Err(error);
    }
    Ok(())
}

pub fn start_export(
    app: AppHandle,
    manager: &JobManager,
    request: ExportProjectRequest,
) -> Result<JobId, AppError> {
    validate_export_request(&request)?;
    let job = manager.begin(JobKind::Export)?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let jobs = worker_app.state::<JobManager>();
        let result = run_export_job(&worker_app, jobs.inner(), job, request).await;
        match result {
            Ok(()) => {
                let _ = jobs.finish(job, JobOutcome::Completed);
            }
            Err(AppError::Cancelled) => {
                let _ = jobs.finish(job, JobOutcome::Cancelled);
            }
            Err(error) => {
                let _ = jobs.update_progress(
                    job,
                    JobProgress {
                        stage: "export".into(),
                        fraction: None,
                        speed: None,
                        eta_seconds: None,
                        message: error.to_string(),
                    },
                );
                let _ = jobs.finish(job, JobOutcome::Failed);
            }
        }
    });
    Ok(job)
}

async fn run_export_job(
    app: &AppHandle,
    manager: &JobManager,
    job: JobId,
    request: ExportProjectRequest,
) -> Result<(), AppError> {
    let capabilities = encoder::detect_encoder_capabilities(app).await;
    let settings = request.project.export;
    let selected = encoder::choose_encoder(
        &capabilities,
        settings.width,
        settings.height,
        request.prefer_hardware,
    );
    let plan = compile_render_plan(
        &request.project,
        request.input.clone(),
        request.output.clone(),
        selected,
    )?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| AppError::ExportFailed(error.to_string()))?;
    let job_dir = cache
        .join("mini-video-tool-v2")
        .join("export")
        .join(format!("job-{}", job.0));
    if job_dir.exists() {
        fs::remove_dir_all(&job_dir)
            .map_err(export_io_error("reset render workspace", &job_dir))?;
    }
    fs::create_dir_all(&job_dir).map_err(export_io_error("create render workspace", &job_dir))?;
    let temp_output = sibling_temp_output(&request.output, job)?;

    let result = async {
        let prepared = prepare_render_assets(&plan, &job_dir)?;
        let graph = build_filter_graph(&plan, &prepared)?;
        let graph_path = job_dir.join("filter-graph.txt");
        fs::write(&graph_path, graph)
            .map_err(export_io_error("write filter graph", &graph_path))?;
        let mut active_plan = plan;
        let mut attempt = ffmpeg::run_attempt(
            app,
            manager,
            job,
            build_ffmpeg_args(&active_plan, &prepared, &graph_path, &temp_output),
            active_plan.duration(),
        )
        .await?;

        if is_cancelled(manager, job)? {
            return Err(AppError::Cancelled);
        }
        if !attempt.succeeded()
            && active_plan.encoder() == EncoderSelection::IntelQsv
            && attempt.max_out_time_us <= 0
            && attempt.is_qsv_initialization_failure()
        {
            let _ = fs::remove_file(&temp_output);
            active_plan = compile_render_plan(
                &request.project,
                request.input.clone(),
                request.output.clone(),
                EncoderSelection::CpuX264,
            )?;
            attempt = ffmpeg::run_attempt(
                app,
                manager,
                job,
                build_ffmpeg_args(&active_plan, &prepared, &graph_path, &temp_output),
                active_plan.duration(),
            )
            .await?;
        }
        if is_cancelled(manager, job)? {
            return Err(AppError::Cancelled);
        }
        if !attempt.succeeded() {
            return Err(AppError::ExportFailed(attempt.diagnostic()));
        }

        let metadata = ffprobe::probe_source(app, &temp_output)
            .await
            .map_err(|error| {
                AppError::ExportFailed(format!("export validation failed: {error}"))
            })?;
        validate_rendered_output(&active_plan, &metadata)?;
        manager.complete_with(job, || {
            publish_temp_output(&temp_output, &request.output, false)
        })
    }
    .await;

    if result.is_err() {
        let _ = fs::remove_file(&temp_output);
    }
    let _ = fs::remove_dir_all(&job_dir);
    result
}

pub fn validate_rendered_output(
    plan: &RenderPlan,
    metadata: &crate::domain::project::SourceMetadata,
) -> Result<(), AppError> {
    if metadata.width != plan.export().width || metadata.height != plan.export().height {
        return Err(AppError::ExportFailed(
            "export validation returned unexpected dimensions".into(),
        ));
    }
    if plan.input().metadata.has_audio && !metadata.has_audio {
        return Err(AppError::ExportFailed(
            "export validation found a missing audio stream".into(),
        ));
    }
    let expected = plan.duration().0;
    if expected <= 0 || metadata.duration.0 <= 0 {
        return Err(AppError::ExportFailed(
            "export validation returned an invalid duration".into(),
        ));
    }
    let frame_tolerance = i64::from(plan.export().frame_rate.denominator)
        .saturating_mul(2_000_000)
        .checked_div(i64::from(plan.export().frame_rate.numerator).max(1))
        .unwrap_or(0);
    let tolerance = frame_tolerance.max(150_000);
    if metadata.duration.0.abs_diff(expected) > tolerance as u64 {
        return Err(AppError::ExportFailed(format!(
            "export validation duration mismatch: expected {}us, got {}us",
            expected, metadata.duration.0
        )));
    }
    Ok(())
}

pub fn validate_export_request(request: &ExportProjectRequest) -> Result<(), AppError> {
    if !request.input.path.is_file() {
        return Err(AppError::SourceUnavailable(format!(
            "export source is missing: {}",
            request.input.path.display()
        )));
    }
    let file_name = request
        .output
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::InvalidInput("export path must have a file name".into()))?;
    if !file_name.to_ascii_lowercase().ends_with(".mp4") {
        return Err(AppError::InvalidInput(
            "export output must be an MP4 file".into(),
        ));
    }
    if request.output.exists() {
        let input = fs::canonicalize(&request.input.path).map_err(export_io_error(
            "resolve export source",
            &request.input.path,
        ))?;
        let output = fs::canonicalize(&request.output).map_err(export_io_error(
            "resolve export destination",
            &request.output,
        ))?;
        if same_path(&input, &output) {
            return Err(AppError::InvalidInput(
                "export destination must be different from the source file".into(),
            ));
        }
    }
    if let Some(parent) = request.output.parent() {
        fs::create_dir_all(parent).map_err(export_io_error("create export directory", parent))?;
    }
    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn sibling_temp_output(destination: &Path, job: JobId) -> Result<PathBuf, AppError> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::InvalidInput("export path must have a valid file name".into()))?;
    Ok(parent.join(format!(".{stem}.job-{}.tmp.mp4", job.0)))
}

fn is_cancelled(manager: &JobManager, job: JobId) -> Result<bool, AppError> {
    Ok(matches!(
        manager.status(job)?,
        JobStatus::Cancelling | JobStatus::Cancelled
    ))
}

fn render_ass(plan: &RenderPlan, style: &CaptionStyle, resolved_font_name: Option<&str>) -> String {
    let font_name = resolved_font_name
        .or(style.font_family.as_deref())
        .unwrap_or("Arial");
    let font_size = (plan.export().height as f32 * style.size_percent / 100.0).max(1.0);
    let alignment = ass_alignment(style.vertical_position, style.horizontal_position);
    let margin_v = (plan.export().height as f32 * style.margin_percent / 100.0).round() as u32;
    let border_style = if style.background_enabled { 3 } else { 1 };
    let back_colour = if style.background_enabled {
        ass_color(&style.background_color, style.background_opacity)
    } else {
        ass_color(&style.shadow_color, 100.0)
    };
    let mut output = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,{font_name},{font_size:.2},{},{},{},{},{},{},0,0,100,100,0,0,{border_style},{:.2},{:.2},{alignment},0,0,{margin_v},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        plan.export().width,
        plan.export().height,
        ass_color(&style.text_color, 100.0),
        ass_color(&style.text_color, 100.0),
        ass_color(&style.outline_color, 100.0),
        back_colour,
        if style.bold { -1 } else { 0 },
        if style.italic { -1 } else { 0 },
        style.outline_width.max(0.0),
        style.shadow.max(0.0),
    );
    for cue in plan.captions() {
        output.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            ass_time(cue.start.0),
            ass_time(cue.end.0),
            ass_text(&cue.text)
        ));
    }
    output
}

fn read_font_family(path: &Path) -> Result<String, AppError> {
    let data = fs::read(path).map_err(export_io_error("read caption font", path))?;
    let face = ttf_parser::Face::parse(&data, 0).map_err(|error| {
        AppError::UnsupportedMedia(format!(
            "cannot parse caption font {}: {error:?}",
            path.display()
        ))
    })?;
    let names = face.names();
    for wanted in [
        ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
        ttf_parser::name_id::FAMILY,
    ] {
        if let Some(name) = names
            .into_iter()
            .filter(|name| name.name_id == wanted)
            .find_map(|name| name.to_string())
            .filter(|name| !name.trim().is_empty())
        {
            return Ok(name);
        }
    }
    Err(AppError::UnsupportedMedia(format!(
        "caption font has no readable family name: {}",
        path.display()
    )))
}

fn ass_alignment(vertical: CaptionVerticalPosition, horizontal: CaptionHorizontalPosition) -> u8 {
    let row = match vertical {
        CaptionVerticalPosition::Bottom => 0,
        CaptionVerticalPosition::Middle => 3,
        CaptionVerticalPosition::Top => 6,
    };
    row + match horizontal {
        CaptionHorizontalPosition::Left => 1,
        CaptionHorizontalPosition::Center => 2,
        CaptionHorizontalPosition::Right => 3,
    }
}

fn ass_color(hex: &str, opacity_percent: f32) -> String {
    let text = hex.trim_start_matches('#');
    let (r, g, b) = if text.len() == 6 {
        (
            u8::from_str_radix(&text[0..2], 16).unwrap_or(255),
            u8::from_str_radix(&text[2..4], 16).unwrap_or(255),
            u8::from_str_radix(&text[4..6], 16).unwrap_or(255),
        )
    } else {
        (255, 255, 255)
    };
    let alpha = (255.0 * (1.0 - opacity_percent.clamp(0.0, 100.0) / 100.0)).round() as u8;
    format!("&H{alpha:02X}{b:02X}{g:02X}{r:02X}")
}

fn ass_time(time_us: i64) -> String {
    let total_cs = time_us.max(0) / 10_000;
    let hours = total_cs / 360_000;
    let minutes = total_cs % 360_000 / 6_000;
    let seconds = total_cs % 6_000 / 100;
    let centiseconds = total_cs % 100;
    format!("{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}")
}

fn ass_text(text: &str) -> String {
    text.replace('\\', r"\\")
        .replace('{', r"\{")
        .replace('}', r"\}")
        .replace('\n', r"\N")
}

fn rect_pixels(
    rect: crate::domain::project::NormalizedRect,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<(u32, u32, u32, u32), AppError> {
    for value in [rect.x, rect.y, rect.width, rect.height] {
        if !value.is_finite() {
            return Err(AppError::InvalidInput(
                "overlay geometry must be finite".into(),
            ));
        }
    }
    if rect.x < 0.0
        || rect.y < 0.0
        || rect.width <= 0.0
        || rect.height <= 0.0
        || rect.x + rect.width > 1.000_001
        || rect.y + rect.height > 1.000_001
    {
        return Err(AppError::InvalidInput(
            "overlay geometry must stay inside normalized frame bounds".into(),
        ));
    }
    let width = (rect.width * canvas_width as f32).round().max(1.0) as u32;
    let height = (rect.height * canvas_height as f32).round().max(1.0) as u32;
    let max_x = canvas_width.saturating_sub(width);
    let max_y = canvas_height.saturating_sub(height);
    let x = ((rect.x * canvas_width as f32).round() as u32).min(max_x);
    let y = ((rect.y * canvas_height as f32).round() as u32).min(max_y);
    Ok((x, y, width, height))
}

fn overlay_enable(spans: &[crate::domain::time::TimeRange]) -> String {
    spans
        .iter()
        .map(|span| {
            format!(
                "between(t,{},{})",
                seconds(span.start().0),
                seconds(span.end().0)
            )
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', r"\:")
        .replace('\'', r"\'")
}

fn seconds(time_us: i64) -> String {
    format!(
        "{}.{:06}",
        time_us / 1_000_000,
        time_us.unsigned_abs() % 1_000_000
    )
}

fn safe_name(value: &str) -> String {
    let filtered = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if filtered.is_empty() {
        "asset".into()
    } else {
        filtered
    }
}

fn export_io_error<'a>(
    operation: &'a str,
    path: &'a Path,
) -> impl FnOnce(std::io::Error) -> AppError + 'a {
    move |error| AppError::ExportFailed(format!("{operation} {}: {error}", path.display()))
}
