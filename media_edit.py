from __future__ import annotations

import html
import json
import os
import re
import subprocess
import tempfile
from collections.abc import Callable
from concurrent.futures import CancelledError
from dataclasses import dataclass, replace
from pathlib import Path

from PIL import Image


@dataclass
class Overlay:
    kind: str
    x: float
    y: float
    w: float
    h: float
    path: Path | None = None
    lock_aspect: bool = True


@dataclass(frozen=True)
class CaptionCue:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class CaptionStyle:
    size_percent: float = 4.5
    text_color: str = "#FFFFFF"
    outline_color: str = "#000000"
    outline_width: float = 1.2
    shadow: float = 2.0
    shadow_color: str = "#000000"
    background_enabled: bool = False
    background_color: str = "#000000"
    background_opacity: float = 55.0
    position: str = "bottom"
    horizontal: str = "center"
    margin_percent: float = 7.0
    bold: bool = False
    italic: bool = False


def resize_overlay(
    overlay: Overlay,
    *,
    handle: str,
    dx: float,
    dy: float,
    video_width: int,
    video_height: int,
    min_size: float = 18.0,
) -> Overlay:
    vw = max(1.0, float(video_width))
    vh = max(1.0, float(video_height))
    left0 = overlay.x * vw
    top0 = overlay.y * vh
    right0 = (overlay.x + overlay.w) * vw
    bottom0 = (overlay.y + overlay.h) * vh
    original_width = max(1.0, right0 - left0)
    original_height = max(1.0, bottom0 - top0)
    has_h = "w" in handle or "e" in handle
    has_v = "n" in handle or "s" in handle

    if not overlay.lock_aspect:
        left, top, right, bottom = left0, top0, right0, bottom0
        if "w" in handle:
            left = _clamp(left0 + dx, 0.0, right0 - min_size)
        elif "e" in handle:
            right = _clamp(right0 + dx, left0 + min_size, vw)
        if "n" in handle:
            top = _clamp(top0 + dy, 0.0, bottom0 - min_size)
        elif "s" in handle:
            bottom = _clamp(bottom0 + dy, top0 + min_size, vh)
        return replace(
            overlay,
            x=left / vw,
            y=top / vh,
            w=(right - left) / vw,
            h=(bottom - top) / vh,
        )

    proposed_width = original_width
    if "w" in handle:
        proposed_width = right0 - (left0 + dx)
    elif "e" in handle:
        proposed_width = (right0 + dx) - left0

    proposed_height = original_height
    if "n" in handle:
        proposed_height = bottom0 - (top0 + dy)
    elif "s" in handle:
        proposed_height = (bottom0 + dy) - top0

    scale_x = proposed_width / original_width
    scale_y = proposed_height / original_height
    if has_h and has_v:
        scale = scale_x if abs(scale_x - 1.0) >= abs(scale_y - 1.0) else scale_y
    elif has_h:
        scale = scale_x
    elif has_v:
        scale = scale_y
    else:
        return overlay

    min_scale = max(min_size / original_width, min_size / original_height)
    center_x = (left0 + right0) / 2.0
    center_y = (top0 + bottom0) / 2.0
    if "w" in handle:
        max_width = right0
    elif "e" in handle:
        max_width = vw - left0
    else:
        max_width = 2.0 * min(center_x, vw - center_x)
    if "n" in handle:
        max_height = bottom0
    elif "s" in handle:
        max_height = vh - top0
    else:
        max_height = 2.0 * min(center_y, vh - center_y)
    max_scale = min(max_width / original_width, max_height / original_height)
    scale = _clamp(scale, min_scale, max_scale)

    width = original_width * scale
    height = original_height * scale
    if "w" in handle:
        right = right0
        left = right - width
    elif "e" in handle:
        left = left0
        right = left + width
    else:
        left = center_x - width / 2.0
        right = center_x + width / 2.0

    if "n" in handle:
        bottom = bottom0
        top = bottom - height
    elif "s" in handle:
        top = top0
        bottom = top + height
    else:
        top = center_y - height / 2.0
        bottom = center_y + height / 2.0

    return replace(
        overlay,
        x=left / vw,
        y=top / vh,
        w=(right - left) / vw,
        h=(bottom - top) / vh,
    )


def build_caption_download_command(
    *,
    yt_dlp: str | Path,
    ffmpeg_dir: str | Path,
    url: str,
    output_dir: str | Path,
) -> list[str]:
    return [
        str(yt_dlp),
        "--no-playlist",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "ar.*",
        "--sub-format",
        "json3",
        "--ffmpeg-location",
        str(ffmpeg_dir),
        "-o",
        str(Path(output_dir) / "%(id)s.%(ext)s"),
        url.strip(),
    ]


def download_arabic_captions(
    *,
    yt_dlp: str | Path,
    ffmpeg_dir: str | Path,
    url: str,
    output_dir: str | Path,
    log_callback: Callable[[str], None] | None = None,
    cancel_requested: Callable[[], bool] | None = None,
    process_callback: Callable[[subprocess.Popen | None], None] | None = None,
) -> Path | None:
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    before = {
        path.resolve(): (path.stat().st_mtime_ns, path.stat().st_size)
        for path in output.glob("*.json3")
        if path.is_file()
    }
    process = subprocess.Popen(
        build_caption_download_command(
            yt_dlp=yt_dlp,
            ffmpeg_dir=ffmpeg_dir,
            url=url,
            output_dir=output,
        ),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=_no_window_flag(),
    )
    if process_callback:
        process_callback(process)
    lines: list[str] = []
    try:
        _raise_if_cancelled(cancel_requested, process)
        assert process.stdout is not None
        for raw_line in process.stdout:
            _raise_if_cancelled(cancel_requested, process)
            line = raw_line.rstrip()
            if line:
                lines.append(line)
                if log_callback:
                    log_callback(line)
        return_code = process.wait()
        _raise_if_cancelled(cancel_requested, process)
    finally:
        if process_callback:
            process_callback(None)
    if return_code != 0:
        raise RuntimeError(_last_lines("\n".join(lines) or "فشل تحميل الكابشن."))
    created: list[Path] = []
    for path in output.glob("*.json3"):
        if not path.is_file():
            continue
        resolved = path.resolve()
        signature = (path.stat().st_mtime_ns, path.stat().st_size)
        if before.get(resolved) != signature:
            created.append(resolved)
    if not created:
        return None
    # Prefer a plain Arabic track over translated variants when several exist.
    created.sort(key=lambda path: (0 if re.search(r"\.ar(?:\.|-)", path.name, re.I) else 1, path.name))
    return created[0]


def parse_srt_cues(text: str) -> list[CaptionCue]:
    blocks = re.split(r"\r?\n\s*\r?\n", str(text).strip())
    cues: list[CaptionCue] = []
    timestamp = re.compile(
        r"(?P<start>\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*"
        r"(?P<end>\d{1,2}:\d{2}:\d{2}[,.]\d{3})"
    )
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        time_index = next((index for index, line in enumerate(lines) if "-->" in line), None)
        if time_index is None:
            continue
        match = timestamp.search(lines[time_index])
        if not match:
            continue
        cue_text = " ".join(lines[time_index + 1 :])
        cue_text = re.sub(r"<[^>]+>", "", cue_text)
        cue_text = html.unescape(cue_text).strip()
        if not cue_text:
            continue
        start = _srt_timestamp_seconds(match.group("start"))
        end = _srt_timestamp_seconds(match.group("end"))
        if end <= start:
            continue
        if cues and cue_text == cues[-1].text and start <= cues[-1].end + 0.05:
            cues[-1] = CaptionCue(cues[-1].start, max(cues[-1].end, end), cue_text)
        else:
            cues.append(CaptionCue(start, end, cue_text))
    return cues


def parse_json3_cues(text: str) -> list[CaptionCue]:
    payload = json.loads(str(text))
    raw: list[CaptionCue] = []
    for event in payload.get("events", []):
        start_ms = event.get("tStartMs")
        duration_ms = event.get("dDurationMs")
        segments = event.get("segs") or []
        if not isinstance(start_ms, (int, float)) or not isinstance(duration_ms, (int, float)):
            continue
        phrase = "".join(str(segment.get("utf8") or "") for segment in segments)
        phrase = re.sub(r"^\s*>>\s*", "", phrase.strip())
        phrase = re.sub(r"\s+", " ", phrase).strip()
        if not phrase or phrase == "\n":
            continue
        start = float(start_ms) / 1000.0
        end = start + max(0.0, float(duration_ms) / 1000.0)
        if end > start:
            raw.append(CaptionCue(start, end, phrase))
    raw.sort(key=lambda cue: (cue.start, cue.end))
    result: list[CaptionCue] = []
    for index, cue in enumerate(raw):
        end = cue.end
        if index + 1 < len(raw):
            next_start = raw[index + 1].start
            if cue.start < next_start < end:
                end = next_start
        if end <= cue.start:
            continue
        result.append(CaptionCue(cue.start, end, cue.text))
    return result


def write_clipped_ass(
    *,
    cues: list[CaptionCue],
    clip_start: float,
    clip_end: float,
    destination: str | Path,
    video_width: int,
    video_height: int,
    font_family: str,
) -> Path:
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    margin_v = max(24, round(video_height * 0.07))
    margin_lr = max(24, round(video_width * 0.06))
    font_size = max(24, round(video_height * 0.045))
    events: list[str] = []
    for cue in cues:
        start = max(float(clip_start), cue.start)
        end = min(float(clip_end), cue.end)
        if end <= start:
            continue
        shifted_start = start - float(clip_start)
        shifted_end = end - float(clip_start)
        events.append(
            "Dialogue: 0,"
            f"{_ass_time(shifted_start)},{_ass_time(shifted_end)},Default,,0,0,0,,"
            f"{_escape_ass_text(cue.text)}"
        )
    if not events:
        raise ValueError("الكابشن العربي موجود لكن مفيش جمل داخل الجزء المختار.")

    content = "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            f"PlayResX: {int(video_width)}",
            f"PlayResY: {int(video_height)}",
            "WrapStyle: 0",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,"
            "Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,"
            "Alignment,MarginL,MarginR,MarginV,Encoding",
            (
                f"Style: Default,{font_family},{font_size},&H00FFFFFF,&H00FFFFFF,&H70000000,&H00000000,"
                f"0,0,0,0,100,100,0,0,1,1.2,2,2,{margin_lr},{margin_lr},{margin_v},1"
            ),
            f"; Alignment=2 MarginV={margin_v} Shadow=2",
            "",
            "[Events]",
            "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
            *events,
            "",
        ]
    )
    destination.write_text(content, encoding="utf-8")
    return destination


def captions_for_section(
    *,
    srt_path: str | Path,
    clip_start: float,
    clip_end: float,
    destination: str | Path,
    video_width: int,
    video_height: int,
    font_family: str,
) -> Path:
    srt_path = Path(srt_path)
    text = srt_path.read_text(encoding="utf-8-sig", errors="replace")
    if srt_path.suffix.lower() == ".json3":
        cues = parse_json3_cues(text)
    else:
        cues = parse_srt_cues(text)
    return write_clipped_ass(
        cues=cues,
        clip_start=clip_start,
        clip_end=clip_end,
        destination=destination,
        video_width=video_width,
        video_height=video_height,
        font_family=font_family,
    )


def probe_media(
    ffprobe: str | Path,
    source: str | Path,
    *,
    cancel_requested: Callable[[], bool] | None = None,
    process_callback: Callable[[subprocess.Popen | None], None] | None = None,
) -> dict:
    try:
        process = subprocess.Popen(
            [
                str(ffprobe),
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(source),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_no_window_flag(),
        )
        if process_callback:
            process_callback(process)
        try:
            _raise_if_cancelled(cancel_requested, process)
            stdout, stderr = process.communicate(timeout=30)
            _raise_if_cancelled(cancel_requested, process)
        finally:
            if process_callback:
                process_callback(None)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.communicate()
        raise RuntimeError("قراءة معلومات الفيديو أخذت وقتًا أطول من المتوقع.") from exc
    if process.returncode != 0:
        raise RuntimeError(_last_lines(stderr or "فشل قراءة الفيديو."))
    return json.loads(stdout)


def video_geometry(info: dict) -> tuple[int, int, float]:
    video = next(
        (stream for stream in info.get("streams", []) if stream.get("codec_type") == "video"),
        None,
    )
    if not video:
        raise ValueError("الملف لا يحتوي على فيديو.")
    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    duration = float((info.get("format") or {}).get("duration") or 0)
    if width <= 0 or height <= 0 or duration <= 0:
        raise ValueError("تعذر قراءة أبعاد أو مدة الفيديو.")
    return width, height, duration


def sync_audio_timing(info: dict) -> tuple[float, float]:
    video = next(
        (stream for stream in info.get("streams", []) if stream.get("codec_type") == "video"),
        None,
    )
    audio = next(
        (stream for stream in info.get("streams", []) if stream.get("codec_type") == "audio"),
        None,
    )
    if not video or not audio:
        return 0.0, 0.0
    format_info = info.get("format") or {}
    try:
        format_start = float(format_info.get("start_time") or 0)
    except (TypeError, ValueError):
        format_start = 0.0

    def stream_start(stream: dict) -> float:
        try:
            value = stream.get("start_time")
            return format_start if value in (None, "") else float(value)
        except (TypeError, ValueError):
            return format_start

    video_start = stream_start(video)
    audio_start = stream_start(audio)
    difference = video_start - audio_start
    if difference >= 0:
        return difference, 0.0
    return 0.0, -difference


def sync_audio_trim(info: dict) -> float:
    return sync_audio_timing(info)[0]


def section_caption_window(
    info: dict,
    *,
    requested_start: float,
    requested_end: float,
) -> tuple[float, float]:
    format_info = info.get("format") or {}
    try:
        duration = float(format_info.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    requested_start = float(requested_start)
    requested_end = float(requested_end)
    if requested_end <= requested_start:
        raise ValueError("وقت نهاية الجزء لازم يكون بعد البداية.")
    if duration <= 0:
        duration = requested_end - requested_start
    # Section downloads can contain keyframe preroll. After stream-copy
    # normalization the local timestamps are rebased, while FFmpeg still ends
    # at the requested source time. Anchor the local duration to that end time.
    actual_end = requested_end
    actual_start = max(0.0, actual_end - duration)
    return actual_start, actual_end


def extract_preview_frame(
    *,
    ffmpeg: str | Path,
    source: str | Path,
    timestamp: float,
    destination: str | Path,
    cancel_requested: Callable[[], bool] | None = None,
    process_callback: Callable[[subprocess.Popen | None], None] | None = None,
) -> Path:
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [
            str(ffmpeg),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-ss",
            f"{max(0.0, float(timestamp)):.3f}",
            "-frames:v",
            "1",
            "-f",
            "image2",
            str(destination),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_no_window_flag(),
    )
    if process_callback:
        process_callback(process)
    try:
        _raise_if_cancelled(cancel_requested, process)
        _stdout, stderr = process.communicate(timeout=30)
        _raise_if_cancelled(cancel_requested, process)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.communicate()
        raise RuntimeError("استخراج لقطة المعاينة أخذ وقتًا أطول من المتوقع.") from exc
    finally:
        if process_callback:
            process_callback(None)
    if process.returncode != 0 or not destination.is_file():
        raise RuntimeError(_last_lines(stderr or "فشل استخراج لقطة المعاينة."))
    return destination


def default_render_destination(source: Path) -> Path:
    source = Path(source)
    suffix = source.suffix.lower()
    if suffix in {".mp4", ".mkv", ".mov", ".webm"}:
        target_suffix = suffix
    elif suffix == ".m4v":
        target_suffix = ".mp4"
    else:
        target_suffix = ".mkv"
    return source.with_name(f"{source.stem}_edited{target_suffix}")


def fast_render_destination(source: Path) -> Path:
    source = Path(source)
    return source.with_name(f"{source.stem}_edited.mp4")


_QSV_AVAILABLE: dict[str, bool] = {}


def _should_use_qsv(*, video_width: int, video_height: int) -> bool:
    """Use QSV where this machine's measurements show a clear speed win.

    Tiny renders pay proportionally more setup/copy overhead; on the target
    Core Ultra 5 125H, x264 was faster at 360p while QSV won strongly at 720p
    and above. Pixel count also handles portrait video better than height alone.
    """
    return max(1, int(video_width)) * max(1, int(video_height)) >= 1280 * 720


def qsv_available(
    ffmpeg: str | Path,
    *,
    cancel_requested: Callable[[], bool] | None = None,
    process_callback: Callable[[subprocess.Popen | None], None] | None = None,
) -> bool:
    key = str(Path(ffmpeg).resolve())
    if key in _QSV_AVAILABLE:
        return _QSV_AVAILABLE[key]
    command = [
        key,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=128x72:d=0.1",
        "-frames:v",
        "1",
        "-c:v",
        "h264_qsv",
        "-f",
        "null",
        "NUL" if os.name == "nt" else "/dev/null",
    ]
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_no_window_flag(),
        )
        if process_callback:
            process_callback(process)
        try:
            _raise_if_cancelled(cancel_requested, process)
            process.communicate(timeout=10)
            _raise_if_cancelled(cancel_requested, process)
            available = process.returncode == 0
        finally:
            if process_callback:
                process_callback(None)
    except CancelledError:
        raise
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        available = False
    except OSError:
        available = False
    _QSV_AVAILABLE[key] = available
    return available


def build_render_command(
    *,
    ffmpeg: str | Path,
    source: Path,
    destination: Path,
    video_width: int,
    video_height: int,
    overlays: list[Overlay],
    captions_ass: Path | None = None,
    font_dir: Path | None = None,
    caption_font_family: str | None = None,
    caption_style: CaptionStyle | None = None,
    audio_trim_start: float = 0.0,
    audio_delay_start: float = 0.0,
    has_audio: bool = True,
    video_encoder: str = "software",
    overlays_prepared: bool = False,
) -> list[str]:
    command = [str(ffmpeg), "-y", "-hide_banner", "-i", str(source)]
    image_overlays = [overlay for overlay in overlays if overlay.kind == "image"]
    for overlay in image_overlays:
        if overlay.path is None:
            raise ValueError("Overlay image path is missing.")
        command += ["-loop", "1", "-framerate", "1", "-i", str(overlay.path)]

    graph: list[str] = ["[0:v]setpts=PTS-STARTPTS[base0]"]
    current = "base0"
    image_input = 1
    stage = 1
    for overlay in overlays:
        x = round(_clamp(overlay.x) * video_width)
        y = round(_clamp(overlay.y) * video_height)
        w = max(2, round(_clamp(overlay.w, 0.001, 1.0) * video_width))
        h = max(2, round(_clamp(overlay.h, 0.001, 1.0) * video_height))
        next_label = f"base{stage}"
        if overlay.kind == "bar":
            graph.append(
                f"[{current}]drawbox=x={x}:y={y}:w={w}:h={h}:color=black@0.92:t=fill[{next_label}]"
            )
        elif overlay.kind == "image":
            if overlays_prepared:
                graph.append(f"[{image_input}:v]format=rgba[ov{stage}]")
            else:
                graph.append(
                    f"[{image_input}:v]scale={w}:{h}:flags=lanczos,format=rgba[ov{stage}]"
                )
            graph.append(
                f"[{current}][ov{stage}]overlay={x}:{y}:format=auto:shortest=1[{next_label}]"
            )
            image_input += 1
        else:
            raise ValueError(f"Unknown overlay kind: {overlay.kind}")
        current = next_label
        stage += 1

    if captions_ass:
        caption_path = _escape_filter_path(Path(captions_ass).resolve())
        option = f"subtitles='{caption_path}'"
        if font_dir:
            option += f":fontsdir='{_escape_filter_path(Path(font_dir).resolve())}'"
        force_style = _caption_force_style(
            caption_style or CaptionStyle(),
            font_family=caption_font_family,
            video_height=video_height,
        )
        if force_style:
            option += f":force_style='{_escape_filter_value(force_style)}'"
        graph.append(f"[{current}]{option}[vout]")
        current = "vout"

    destination = Path(destination)
    audio_map: str | None = None
    if has_audio:
        if audio_trim_start > 0.001:
            graph.append(
                "[0:a]asetpts=PTS-STARTPTS,"
                f"atrim=start={float(audio_trim_start):.6f},"
                "asetpts=PTS-STARTPTS[aout]"
            )
        elif audio_delay_start > 0.001:
            graph.append(
                "[0:a]asetpts="
                f"PTS-STARTPTS+{float(audio_delay_start):.6f}/TB[aout]"
            )
        else:
            graph.append("[0:a]asetpts=PTS-STARTPTS[aout]")
        audio_map = "[aout]"

    command += [
        "-filter_complex",
        ";".join(graph),
        "-map",
        f"[{current}]",
        "-stats_period",
        "0.25",
        "-progress",
        "pipe:1",
        "-nostats",
    ]
    if audio_map is not None:
        insert_at = command.index("-progress")
        command[insert_at:insert_at] = ["-map", audio_map]
    command += _encoding_args_for_suffix(destination.suffix.lower(), video_encoder=video_encoder)
    command += ["-shortest", str(destination)]
    return command


def render_video(
    *,
    ffmpeg: str | Path,
    ffprobe: str | Path,
    source: Path,
    overlays: list[Overlay],
    captions_ass: Path | None = None,
    font_dir: Path | None = None,
    caption_font_family: str | None = None,
    caption_style: CaptionStyle | None = None,
    destination: Path | None = None,
    prefer_hardware: bool = True,
    progress_callback: Callable[[float], None] | None = None,
    telemetry_callback: Callable[[dict], None] | None = None,
    log_callback: Callable[[str], None] | None = None,
    cancel_requested: Callable[[], bool] | None = None,
    process_callback: Callable[[subprocess.Popen | None], None] | None = None,
) -> Path:
    source = Path(source).resolve()
    info = probe_media(
        ffprobe,
        source,
        cancel_requested=cancel_requested,
        process_callback=process_callback,
    )
    _raise_if_cancelled(cancel_requested)
    width, height, duration = video_geometry(info)
    has_audio = any(stream.get("codec_type") == "audio" for stream in info.get("streams", []))
    audio_trim_start, audio_delay_start = sync_audio_timing(info)
    destination = Path(destination or default_render_destination(source)).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_destination = _temporary_sibling(destination)
    encoder = (
        "qsv"
        if (
            prefer_hardware
            and destination.suffix.lower() != ".webm"
            and _should_use_qsv(video_width=width, video_height=height)
            and qsv_available(
                ffmpeg,
                cancel_requested=cancel_requested,
                process_callback=process_callback,
            )
        )
        else "software"
    )
    if telemetry_callback:
        telemetry_callback(
            {
                "stage": "render_prepare",
                "percent": 0.0,
                "encoder": "Intel Quick Sync" if encoder == "qsv" else "CPU H.264/VP9",
                "duration": duration,
            }
        )
    try:
        with tempfile.TemporaryDirectory(prefix="MiniVideoTool-overlays-") as overlay_temp:
            prepared_overlays = _prepare_static_overlays(
                overlays,
                video_width=width,
                video_height=height,
                directory=Path(overlay_temp),
            )

            def execute(selected_encoder: str) -> tuple[int, list[str]]:
                temp_destination.unlink(missing_ok=True)
                command = build_render_command(
                    ffmpeg=ffmpeg,
                    source=source,
                    destination=temp_destination,
                    video_width=width,
                    video_height=height,
                    overlays=prepared_overlays,
                    captions_ass=captions_ass,
                    font_dir=font_dir,
                    caption_font_family=caption_font_family,
                    caption_style=caption_style,
                    audio_trim_start=audio_trim_start,
                    audio_delay_start=audio_delay_start,
                    has_audio=has_audio,
                    video_encoder=selected_encoder,
                    overlays_prepared=True,
                )
                return _run_render_process(
                    command,
                    duration=duration,
                    encoder_label="Intel Quick Sync" if selected_encoder == "qsv" else "CPU",
                    progress_callback=progress_callback,
                    telemetry_callback=telemetry_callback,
                    log_callback=log_callback,
                    cancel_requested=cancel_requested,
                    process_callback=process_callback,
                )

            return_code, lines = execute(encoder)
            if (
                return_code != 0
                or not temp_destination.is_file()
                or temp_destination.stat().st_size <= 0
            ) and encoder == "qsv":
                if log_callback:
                    log_callback("تعذر Quick Sync في هذا الملف؛ رجوع تلقائي لترميز CPU H.264.")
                encoder = "software"
                if telemetry_callback:
                    telemetry_callback(
                        {
                            "stage": "render_prepare",
                            "percent": 0.0,
                            "encoder": "CPU fallback",
                            "duration": duration,
                        }
                    )
                return_code, lines = execute(encoder)

            if (
                return_code != 0
                or not temp_destination.is_file()
                or temp_destination.stat().st_size <= 0
            ):
                raise RuntimeError(_last_lines("\n".join(lines) or "فشل إخراج الفيديو."))
        _raise_if_cancelled(cancel_requested)
        temp_destination.replace(destination)
    finally:
        temp_destination.unlink(missing_ok=True)
    if progress_callback:
        progress_callback(100.0)
    if telemetry_callback:
        telemetry_callback(
            {
                "stage": "render_done",
                "percent": 100.0,
                "duration": duration,
                "output_size": destination.stat().st_size,
                "encoder": "Intel Quick Sync" if encoder == "qsv" else "CPU",
            }
        )
    return destination


def _encoding_args_for_suffix(suffix: str, *, video_encoder: str = "software") -> list[str]:
    if video_encoder == "qsv" and suffix in {".mp4", ".mov", ".mkv"}:
        args = [
            "-c:v",
            "h264_qsv",
            "-preset",
            "fast",
            "-global_quality",
            "20",
            "-look_ahead",
            "0",
            "-low_power",
            "1",
            "-async_depth",
            "6",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-pix_fmt",
            "nv12",
        ]
        if suffix in {".mp4", ".mov"}:
            args += ["-movflags", "+faststart"]
        return args
    if suffix == ".webm":
        return [
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "30",
            "-b:v",
            "0",
            "-deadline",
            "good",
            "-cpu-used",
            "5",
            "-row-mt",
            "1",
            "-c:a",
            "libopus",
            "-b:a",
            "160k",
            "-pix_fmt",
            "yuv420p",
        ]
    args = [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-pix_fmt",
        "yuv420p",
    ]
    if suffix in {".mp4", ".mov"}:
        args += ["-movflags", "+faststart"]
    return args


def _prepare_static_overlays(
    overlays: list[Overlay],
    *,
    video_width: int,
    video_height: int,
    directory: Path,
) -> list[Overlay]:
    prepared: list[Overlay] = []
    directory.mkdir(parents=True, exist_ok=True)
    for index, overlay in enumerate(overlays):
        if overlay.kind != "image" or overlay.path is None:
            prepared.append(replace(overlay))
            continue
        width = max(2, round(_clamp(overlay.w, 0.001, 1.0) * video_width))
        height = max(2, round(_clamp(overlay.h, 0.001, 1.0) * video_height))
        destination = directory / f"overlay-{index}-{width}x{height}.png"
        with Image.open(overlay.path) as image:
            rgba = image.convert("RGBA")
            if rgba.size != (width, height):
                rgba = rgba.resize((width, height), Image.Resampling.LANCZOS)
            rgba.save(destination, format="PNG", optimize=True)
        prepared.append(replace(overlay, path=destination))
    return prepared


def _run_render_process(
    command: list[str],
    *,
    duration: float,
    encoder_label: str,
    progress_callback: Callable[[float], None] | None,
    telemetry_callback: Callable[[dict], None] | None,
    log_callback: Callable[[str], None] | None,
    process_callback: Callable[[subprocess.Popen | None], None] | None = None,
    cancel_requested: Callable[[], bool] | None = None,
) -> tuple[int, list[str]]:
    progress_state: dict[str, str] = {}
    progress_keys = {
        "frame",
        "fps",
        "bitrate",
        "total_size",
        "out_time_us",
        "out_time_ms",
        "out_time",
        "speed",
        "progress",
    }
    lines: list[str] = []
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=_no_window_flag(),
    )
    if process_callback:
        process_callback(process)
    try:
        _raise_if_cancelled(cancel_requested, process)
        assert process.stdout is not None
        for raw_line in process.stdout:
            _raise_if_cancelled(cancel_requested, process)
            line = raw_line.rstrip()
            if not line:
                continue
            lines.append(line)
            key, separator, value = line.partition("=")
            if separator and key in progress_keys:
                progress_state[key] = value.strip()
                if key == "progress":
                    telemetry = _ffmpeg_telemetry_event(
                        progress_state,
                        duration=duration,
                        stage="render",
                    )
                    telemetry["encoder"] = encoder_label
                    if telemetry_callback:
                        telemetry_callback(telemetry)
                    if progress_callback:
                        progress_callback(telemetry["percent"])
                continue
            if log_callback:
                log_callback(line)
        return_code = process.wait()
        _raise_if_cancelled(cancel_requested, process)
        return return_code, lines
    finally:
        if process_callback:
            process_callback(None)


def _raise_if_cancelled(
    cancel_requested: Callable[[], bool] | None,
    process: subprocess.Popen | None = None,
) -> None:
    if not cancel_requested or not cancel_requested():
        return
    if process is not None and process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass
    raise CancelledError()


def _caption_force_style(
    style: CaptionStyle,
    *,
    font_family: str | None,
    video_height: int,
) -> str:
    position_map = {
        ("bottom", "left"): 1,
        ("bottom", "center"): 2,
        ("bottom", "right"): 3,
        ("middle", "left"): 4,
        ("middle", "center"): 5,
        ("middle", "right"): 6,
        ("top", "left"): 7,
        ("top", "center"): 8,
        ("top", "right"): 9,
    }
    alignment = position_map.get((style.position, style.horizontal), 2)
    font_size = max(
        12,
        round(max(1, video_height) * max(1.0, min(12.0, style.size_percent)) / 100.0),
    )
    margin_v = max(
        0,
        round(max(1, video_height) * max(0.0, min(40.0, style.margin_percent)) / 100.0),
    )
    back_color = (
        _ass_color(style.background_color, opacity=style.background_opacity)
        if style.background_enabled
        else _ass_color(style.shadow_color, opacity=100.0)
    )
    values = [
        f"Fontsize={font_size}",
        f"PrimaryColour={_ass_color(style.text_color, opacity=100.0)}",
        f"OutlineColour={_ass_color(style.outline_color, opacity=100.0)}",
        f"BackColour={back_color}",
        f"Bold={-1 if style.bold else 0}",
        f"Italic={-1 if style.italic else 0}",
        f"BorderStyle={3 if style.background_enabled else 1}",
        f"Outline={max(0.0, min(8.0, float(style.outline_width))):.2f}",
        f"Shadow={max(0.0, min(8.0, float(style.shadow))):.2f}",
        f"Alignment={alignment}",
        f"MarginV={margin_v}",
    ]
    if font_family:
        values.insert(0, f"Fontname={font_family}")
    return ",".join(values)


def _ass_color(value: str, *, opacity: float) -> str:
    text = str(value or "#000000").strip().lstrip("#")
    if len(text) != 6 or not re.fullmatch(r"[0-9A-Fa-f]{6}", text):
        text = "000000"
    red = int(text[0:2], 16)
    green = int(text[2:4], 16)
    blue = int(text[4:6], 16)
    visible = max(0.0, min(100.0, float(opacity))) / 100.0
    alpha = round((1.0 - visible) * 255)
    return f"&H{alpha:02X}{blue:02X}{green:02X}{red:02X}"


def _srt_timestamp_seconds(value: str) -> float:
    hours, minutes, seconds_ms = value.replace(".", ",").split(":")
    seconds, millis = seconds_ms.split(",", 1)
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def _ass_time(seconds: float) -> str:
    centiseconds = max(0, round(float(seconds) * 100))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    secs, cs = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _escape_ass_text(text: str) -> str:
    return (
        str(text)
        .replace("\\", r"\\")
        .replace("{", r"\{")
        .replace("}", r"\}")
        .replace("\r", " ")
        .replace("\n", r"\N")
    )


def _escape_filter_path(path: Path) -> str:
    return str(path).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


def _escape_filter_value(value: str) -> str:
    return str(value).replace("\\", r"\\").replace("'", r"\'")


def _ffmpeg_telemetry_event(state: dict[str, str], *, duration: float, stage: str) -> dict:
    out_time = 0.0
    for key in ("out_time_us", "out_time_ms"):
        value = _optional_float(state.get(key))
        if value is not None:
            out_time = max(0.0, value / 1_000_000.0)
            break
    speed_text = str(state.get("speed") or "").strip()
    speed_factor = _optional_float(speed_text.rstrip("x"))
    percent = min(100.0, max(0.0, out_time / duration * 100.0)) if duration > 0 else 0.0
    eta = None
    if speed_factor and speed_factor > 0 and duration > out_time:
        eta = (duration - out_time) / speed_factor
    return {
        "stage": stage,
        "percent": percent,
        "out_time": out_time,
        "duration": duration,
        "frame": _optional_float(state.get("frame")),
        "fps": _optional_float(state.get("fps")),
        "bitrate": str(state.get("bitrate") or "").strip(),
        "total_size": _optional_float(state.get("total_size")),
        "speed_text": speed_text,
        "speed_factor": speed_factor,
        "eta_seconds": eta,
        "progress": str(state.get("progress") or "").strip(),
    }


def _optional_float(value) -> float | None:
    text = str(value or "").strip()
    if not text or text.lower() in {"na", "n/a", "none", "unknown"}:
        return None
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    if number != number or number in {float("inf"), float("-inf")}:
        return None
    return number


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def _last_lines(text: str, count: int = 10) -> str:
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    return "\n".join(lines[-count:]) or "حدث خطأ غير معروف."


def _temporary_sibling(destination: Path) -> Path:
    destination = Path(destination).resolve()
    fd, name = tempfile.mkstemp(
        dir=str(destination.parent),
        prefix=f".{destination.stem}.tmp-",
        suffix=destination.suffix,
    )
    os.close(fd)
    return Path(name)


def _no_window_flag() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
