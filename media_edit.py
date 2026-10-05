from __future__ import annotations

import html
import json
import os
import re
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path


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
    lines: list[str] = []
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.rstrip()
        if line:
            lines.append(line)
            if log_callback:
                log_callback(line)
    return_code = process.wait()
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


def probe_media(ffprobe: str | Path, source: str | Path) -> dict:
    try:
        result = subprocess.run(
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
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            creationflags=_no_window_flag(),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("قراءة معلومات الفيديو أخذت وقتًا أطول من المتوقع.") from exc
    if result.returncode != 0:
        raise RuntimeError(_last_lines(result.stderr or "فشل قراءة الفيديو."))
    return json.loads(result.stdout)


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
) -> Path:
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
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
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_no_window_flag(),
    )
    if result.returncode != 0 or not destination.is_file():
        raise RuntimeError(_last_lines(result.stderr or "فشل استخراج لقطة المعاينة."))
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
    audio_trim_start: float = 0.0,
    audio_delay_start: float = 0.0,
    has_audio: bool = True,
) -> list[str]:
    command = [str(ffmpeg), "-y", "-hide_banner", "-i", str(source)]
    image_overlays = [overlay for overlay in overlays if overlay.kind == "image"]
    for overlay in image_overlays:
        if overlay.path is None:
            raise ValueError("Overlay image path is missing.")
        command += ["-loop", "1", "-i", str(overlay.path)]

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
        if caption_font_family:
            option += (
                ":force_style='Fontname="
                f"{_escape_filter_value(caption_font_family)}'"
            )
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
        "-progress",
        "pipe:1",
        "-nostats",
    ]
    if audio_map is not None:
        insert_at = command.index("-progress")
        command[insert_at:insert_at] = ["-map", audio_map]
    command += _encoding_args_for_suffix(destination.suffix.lower())
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
    destination: Path | None = None,
    progress_callback: Callable[[float], None] | None = None,
    log_callback: Callable[[str], None] | None = None,
) -> Path:
    source = Path(source).resolve()
    info = probe_media(ffprobe, source)
    width, height, duration = video_geometry(info)
    has_audio = any(stream.get("codec_type") == "audio" for stream in info.get("streams", []))
    audio_trim_start, audio_delay_start = sync_audio_timing(info)
    destination = Path(destination or default_render_destination(source)).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_destination = _temporary_sibling(destination)
    lines: list[str] = []
    try:
        command = build_render_command(
            ffmpeg=ffmpeg,
            source=source,
            destination=temp_destination,
            video_width=width,
            video_height=height,
            overlays=overlays,
            captions_ass=captions_ass,
            font_dir=font_dir,
            caption_font_family=caption_font_family,
            audio_trim_start=audio_trim_start,
            audio_delay_start=audio_delay_start,
            has_audio=has_audio,
        )
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
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if not line:
                continue
            lines.append(line)
            if line.startswith("out_time_ms="):
                try:
                    seconds = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                if progress_callback and duration > 0:
                    progress_callback(min(100.0, seconds / duration * 100.0))
            elif log_callback and not line.startswith(
                ("progress=", "frame=", "fps=", "bitrate=", "total_size=")
            ):
                log_callback(line)
        return_code = process.wait()
        if (
            return_code != 0
            or not temp_destination.is_file()
            or temp_destination.stat().st_size <= 0
        ):
            raise RuntimeError(_last_lines("\n".join(lines) or "فشل إخراج الفيديو."))
        temp_destination.replace(destination)
    finally:
        temp_destination.unlink(missing_ok=True)
    if progress_callback:
        progress_callback(100.0)
    return destination


def _encoding_args_for_suffix(suffix: str) -> list[str]:
    if suffix == ".webm":
        return [
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "30",
            "-b:v",
            "0",
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
