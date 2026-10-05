from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path


QUALITY_FORMATS = {
    "أفضل جودة متاحة": "bv*+ba/b",
    "1080p": "bv*[height<=1080]+ba/b[height<=1080]",
    "720p": "bv*[height<=720]+ba/b[height<=720]",
    "480p": "bv*[height<=480]+ba/b[height<=480]",
    "360p": "bv*[height<=360]+ba/b[height<=360]",
}

SILENCE_THRESHOLD_DB = -35
SILENCE_MIN_SECONDS = 0.6
SILENCE_MARGIN_SECONDS = 0.2


def parse_timecode(value: str) -> float:
    text = str(value).strip()
    if not text:
        raise ValueError("اكتب الوقت.")
    parts = text.split(":")
    if len(parts) == 1:
        seconds = float(parts[0])
    elif len(parts) == 2:
        minutes = int(parts[0])
        seconds_part = float(parts[1])
        if minutes < 0 or not 0 <= seconds_part < 60:
            raise ValueError("صيغة الوقت غير صحيحة.")
        seconds = minutes * 60 + seconds_part
    elif len(parts) == 3:
        hours = int(parts[0])
        minutes = int(parts[1])
        seconds_part = float(parts[2])
        if hours < 0 or not 0 <= minutes < 60 or not 0 <= seconds_part < 60:
            raise ValueError("صيغة الوقت غير صحيحة.")
        seconds = hours * 3600 + minutes * 60 + seconds_part
    else:
        raise ValueError("استخدم HH:MM:SS أو MM:SS.")
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError("الوقت لازم يكون رقم موجب.")
    return seconds


def format_timecode(seconds: float) -> str:
    total_ms = max(0, round(float(seconds) * 1000))
    hours, remainder_ms = divmod(total_ms, 3_600_000)
    minutes, remainder_ms = divmod(remainder_ms, 60_000)
    whole_seconds, millis = divmod(remainder_ms, 1000)
    if millis == 0:
        return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}"
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{millis:03d}".rstrip("0")


def build_download_command(
    *,
    yt_dlp: str | Path,
    ffmpeg_dir: str | Path,
    url: str,
    start: float,
    end: float,
    quality: str,
    output_dir: str | Path,
) -> list[str]:
    if end <= start:
        raise ValueError("وقت النهاية لازم يكون بعد البداية.")
    try:
        format_selector = QUALITY_FORMATS[quality]
    except KeyError as exc:
        raise ValueError("الجودة غير معروفة.") from exc
    quality_tag = "best" if quality == "أفضل جودة متاحة" else quality
    section_tag = (
        f"{format_timecode(start).replace(':', '-')}-"
        f"{format_timecode(end).replace(':', '-')}"
    )
    return [
        str(yt_dlp),
        "--no-playlist",
        "--newline",
        "--ffmpeg-location",
        str(ffmpeg_dir),
        "--download-sections",
        f"*{format_timecode(start)}-{format_timecode(end)}",
        "--progress",
        "--progress-template",
        "download:PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--print",
        "after_move:FINAL_FILE:%(filepath)s",
        "-f",
        format_selector,
        "--no-overwrites",
        "-o",
        str(Path(output_dir) / f"%(title).120B [%(id)s] [{section_tag}] [{quality_tag}].%(ext)s"),
        url.strip(),
    ]


def parse_download_progress(line: str) -> tuple[float, str, str] | None:
    text = str(line).strip()
    if not text.startswith("PROGRESS:"):
        return None
    parts = text.removeprefix("PROGRESS:").split("|", 2)
    if len(parts) != 3:
        return None
    percent_text = parts[0].replace("%", "").strip()
    try:
        percent = float(percent_text)
    except ValueError:
        return None
    return max(0.0, min(100.0, percent)), parts[1].strip(), parts[2].strip()


def download_section(
    *,
    yt_dlp: str | Path,
    ffmpeg_dir: str | Path,
    url: str,
    start: float,
    end: float,
    quality: str,
    output_dir: str | Path,
    progress_callback: Callable[[float, str, str], None] | None = None,
    log_callback: Callable[[str], None] | None = None,
) -> Path:
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    command = build_download_command(
        yt_dlp=yt_dlp,
        ffmpeg_dir=ffmpeg_dir,
        url=url,
        start=start,
        end=end,
        quality=quality,
        output_dir=output,
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
    final_file: Path | None = None
    lines: list[str] = []
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.rstrip()
        if not line:
            continue
        lines.append(line)
        if line.startswith("FINAL_FILE:"):
            final_file = Path(line.removeprefix("FINAL_FILE:").strip()).resolve()
            continue
        progress = parse_download_progress(line)
        if progress and progress_callback:
            progress_callback(*progress)
        elif log_callback:
            log_callback(line)
    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(_last_lines("\n".join(lines) or "فشل التحميل."))
    if final_file and final_file.is_file():
        return normalize_partial_download(
            ffmpeg_dir=ffmpeg_dir,
            source=final_file,
            log_callback=log_callback,
        )
    section_tag = (
        f"{format_timecode(start).replace(':', '-')}-"
        f"{format_timecode(end).replace(':', '-')}"
    )
    quality_tag = "best" if quality == "أفضل جودة متاحة" else quality
    matches = sorted(
        (
            path
            for path in output.iterdir()
            if path.is_file()
            and f"[{section_tag}]" in path.name
            and f"[{quality_tag}]" in path.name
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if matches:
        return normalize_partial_download(
            ffmpeg_dir=ffmpeg_dir,
            source=matches[0].resolve(),
            log_callback=log_callback,
        )
    raise RuntimeError("تم التحميل لكن تعذر تحديد اسم الملف الناتج.")


def normalize_partial_download(
    *,
    ffmpeg_dir: str | Path,
    source: str | Path,
    log_callback: Callable[[str], None] | None = None,
) -> Path:
    """Remove audio-only preroll caused by keyframe-aligned section downloads.

    This is a stream-copy remux only. It never re-encodes the downloaded video.
    """
    source = Path(source).resolve()
    ffmpeg_dir = Path(ffmpeg_dir)
    ffmpeg = ffmpeg_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    ffprobe = ffmpeg_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if not ffmpeg.is_file() or not ffprobe.is_file():
        return source

    try:
        info = _probe(ffprobe, source)
        streams = info.get("streams") or []
        video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
        audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
        if not video or not audio:
            return source

        def number(value, default: float = 0.0) -> float:
            try:
                return float(value)
            except (TypeError, ValueError):
                return default

        format_start = number((info.get("format") or {}).get("start_time"))
        video_start = number(video.get("start_time"), format_start)
        audio_start = number(audio.get("start_time"), format_start)
        # yt-dlp/FFmpeg may include audio from before the first decodable video
        # keyframe. Trim only that specific case; other timing layouts are left
        # untouched for the editor's A/V sync logic.
        if video_start - audio_start <= 0.25:
            return source
        seek = max(0.0, video_start - format_start)
        temp_destination = _temporary_sibling(source)
        try:
            if log_callback:
                log_callback("تسوية بداية الصوت والصورة بدون إعادة ترميز...")
            result = subprocess.run(
                [
                    str(ffmpeg),
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{seek:.6f}",
                    "-i",
                    str(source),
                    "-map",
                    "0",
                    "-c",
                    "copy",
                    "-avoid_negative_ts",
                    "make_zero",
                    str(temp_destination),
                ],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=_no_window_flag(),
            )
            if result.returncode != 0 or not temp_destination.is_file() or temp_destination.stat().st_size <= 0:
                if log_callback:
                    log_callback("تعذر تسوية بداية المسارات؛ تم الاحتفاظ بالملف الأصلي.")
                return source
            temp_destination.replace(source)
        finally:
            temp_destination.unlink(missing_ok=True)
    except Exception as exc:
        if log_callback:
            log_callback(f"تم الاحتفاظ بالملف الأصلي بعد تعذر تسوية البداية: {exc}")
    return source


def parse_silence_intervals(text: str) -> list[tuple[float, float]]:
    starts: list[float] = []
    result: list[tuple[float, float]] = []
    for line in str(text).splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            starts.append(float(start_match.group(1)))
        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match and starts:
            start = starts.pop(0)
            end = float(end_match.group(1))
            if end > start:
                result.append((start, end))
    return result


def silence_to_keep_ranges(
    *,
    duration: float,
    silence_intervals: list[tuple[float, float]],
    margin: float = SILENCE_MARGIN_SECONDS,
) -> list[tuple[float, float]]:
    duration = max(0.0, float(duration))
    cuts: list[tuple[float, float]] = []
    for start, end in silence_intervals:
        cut_start = max(0.0, float(start) + margin)
        cut_end = min(duration, float(end) - margin)
        if cut_end > cut_start:
            if cuts and cut_start <= cuts[-1][1]:
                cuts[-1] = (cuts[-1][0], max(cuts[-1][1], cut_end))
            else:
                cuts.append((cut_start, cut_end))

    keep: list[tuple[float, float]] = []
    cursor = 0.0
    for cut_start, cut_end in cuts:
        if cut_start > cursor:
            keep.append((round(cursor, 6), round(cut_start, 6)))
        cursor = max(cursor, cut_end)
    if cursor < duration:
        keep.append((round(cursor, 6), round(duration, 6)))
    return keep


def default_silence_destination(source: Path) -> Path:
    source = Path(source)
    suffix = source.suffix.lower()
    if suffix in {".mp4", ".mkv", ".mov", ".webm"}:
        target_suffix = suffix
    elif suffix == ".m4v":
        target_suffix = ".mp4"
    else:
        target_suffix = ".mkv"
    return source.with_name(f"{source.stem}_no_silence{target_suffix}")


def aligned_stream_window(info: dict) -> tuple[float, float, float]:
    streams = info.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not video or not audio:
        raise ValueError("الفيديو لازم يحتوي على صورة وصوت.")

    def number(value, default: float = 0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    format_info = info.get("format") or {}
    format_start = number(format_info.get("start_time"))
    format_duration = number(format_info.get("duration"))
    video_start = number(video.get("start_time"), format_start)
    audio_start = number(audio.get("start_time"), format_start)
    common_start = max(format_start, video_start, audio_start)
    format_end = format_start + max(0.0, format_duration)
    common_duration = max(0.0, format_end - common_start)
    return (
        max(0.0, common_start - video_start),
        max(0.0, common_start - audio_start),
        common_duration,
    )


def cut_silence(
    *,
    ffmpeg: str | Path,
    ffprobe: str | Path,
    source: str | Path,
    destination: str | Path | None = None,
    status_callback: Callable[[str], None] | None = None,
) -> Path:
    source = Path(source).resolve()
    if not source.is_file():
        raise ValueError("اختار ملف فيديو صحيح.")
    info = _probe(ffprobe, source)
    streams = info.get("streams") or []
    if not any(stream.get("codec_type") == "video" for stream in streams):
        raise ValueError("الملف لا يحتوي على فيديو.")
    if not any(stream.get("codec_type") == "audio" for stream in streams):
        raise ValueError("الملف لا يحتوي على صوت لتحليل الصمت.")
    video_offset, audio_offset, duration = aligned_stream_window(info)
    if duration <= 0:
        raise ValueError("تعذر قراءة مدة الفيديو.")

    if status_callback:
        status_callback("تحليل الصوت واكتشاف فترات الصمت...")
    detection = subprocess.run(
        [
            str(ffmpeg),
            "-hide_banner",
            "-i",
            str(source),
            "-vn",
            "-af",
            (
                "asetpts=PTS-STARTPTS,"
                f"atrim=start={audio_offset:.6f},asetpts=PTS-STARTPTS,"
                f"silencedetect=n={SILENCE_THRESHOLD_DB}dB:d={SILENCE_MIN_SECONDS}"
            ),
            "-f",
            "null",
            "NUL" if os.name == "nt" else "/dev/null",
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_no_window_flag(),
    )
    if detection.returncode != 0:
        raise RuntimeError(_last_lines(detection.stderr or "فشل تحليل الصمت."))

    intervals = parse_silence_intervals(detection.stderr)
    # If the file ends in silence, ffmpeg normally emits silence_end. Keep the
    # logic conservative if a build ever omits it: never invent a cut.
    keep_ranges = silence_to_keep_ranges(
        duration=duration,
        silence_intervals=intervals,
        margin=SILENCE_MARGIN_SECONDS,
    )
    if not intervals or keep_ranges == [(0.0, round(duration, 6))]:
        if status_callback:
            status_callback("مفيش صمت يحتاج قص؛ بننسخ الملف كما هو...")
        destination = Path(
            destination or source.with_name(f"{source.stem}_no_silence{source.suffix}")
        ).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp_destination = _temporary_sibling(destination)
        try:
            shutil.copy2(source, temp_destination)
            temp_destination.replace(destination)
        except Exception:
            temp_destination.unlink(missing_ok=True)
            raise
        return destination
    if not keep_ranges:
        raise ValueError("الفيديو كله صمت تقريبًا؛ لم يتم إنشاء ملف فارغ.")

    destination = Path(destination or default_silence_destination(source)).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_destination = _temporary_sibling(destination)
    if status_callback:
        status_callback("إعادة بناء الفيديو بعد حذف الصمت...")

    graph_lines: list[str] = []
    concat_inputs: list[str] = []
    for index, (start, end) in enumerate(keep_ranges):
        video_start = video_offset + start
        video_end = video_offset + end
        audio_start = audio_offset + start
        audio_end = audio_offset + end
        graph_lines.append(
            (
                "[0:v]setpts=PTS-STARTPTS,"
                f"trim=start={video_start:.6f}:end={video_end:.6f},"
                f"setpts=PTS-STARTPTS[v{index}]"
            )
        )
        graph_lines.append(
            (
                "[0:a]asetpts=PTS-STARTPTS,"
                f"atrim=start={audio_start:.6f}:end={audio_end:.6f},"
                f"asetpts=PTS-STARTPTS[a{index}]"
            )
        )
        concat_inputs.append(f"[v{index}][a{index}]")
    graph_lines.append(
        "".join(concat_inputs)
        + f"concat=n={len(keep_ranges)}:v=1:a=1[vout][aout]"
    )

    script_handle = tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        suffix=".ffgraph",
        delete=False,
    )
    try:
        with script_handle:
            script_handle.write(";\n".join(graph_lines))
        command = [
            str(ffmpeg),
            "-y",
            "-hide_banner",
            "-i",
            str(source),
            "-filter_complex_script",
            script_handle.name,
            "-map",
            "[vout]",
            "-map",
            "[aout]",
        ]
        command += _encoding_args_for_suffix(destination.suffix.lower())
        command.append(str(temp_destination))
        rendered = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_no_window_flag(),
        )
        if (
            rendered.returncode != 0
            or not temp_destination.is_file()
            or temp_destination.stat().st_size <= 0
        ):
            temp_destination.unlink(missing_ok=True)
            raise RuntimeError(_last_lines(rendered.stderr or "فشل قص الصمت."))
        temp_destination.replace(destination)
    finally:
        Path(script_handle.name).unlink(missing_ok=True)
        temp_destination.unlink(missing_ok=True)
    return destination


def _probe(ffprobe: str | Path, source: Path) -> dict:
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


def _last_lines(text: str, count: int = 8) -> str:
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
