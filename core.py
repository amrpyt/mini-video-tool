from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
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
        "-f",
        format_selector,
        "--merge-output-format",
        "mkv",
        "--no-overwrites",
        "-o",
        str(Path(output_dir) / f"%(title).120B [%(id)s] [{section_tag}].%(ext)s"),
        url.strip(),
    ]


def download_section(
    *,
    yt_dlp: str | Path,
    ffmpeg_dir: str | Path,
    url: str,
    start: float,
    end: float,
    quality: str,
    output_dir: str | Path,
) -> str:
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
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_no_window_flag(),
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "فشل التحميل.").strip()
        raise RuntimeError(_last_lines(message))
    return (result.stdout or "").strip()


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


def cut_silence(
    *,
    ffmpeg: str | Path,
    ffprobe: str | Path,
    source: str | Path,
    destination: str | Path | None = None,
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
    duration = float((info.get("format") or {}).get("duration") or 0)
    if duration <= 0:
        raise ValueError("تعذر قراءة مدة الفيديو.")

    detection = subprocess.run(
        [
            str(ffmpeg),
            "-hide_banner",
            "-i",
            str(source),
            "-vn",
            "-af",
            f"silencedetect=n={SILENCE_THRESHOLD_DB}dB:d={SILENCE_MIN_SECONDS}",
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
        destination = Path(
            destination or source.with_name(f"{source.stem}_no_silence{source.suffix}")
        ).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        return destination
    if not keep_ranges:
        raise ValueError("الفيديو كله صمت تقريبًا؛ لم يتم إنشاء ملف فارغ.")

    destination = Path(destination or source.with_name(f"{source.stem}_no_silence.mp4")).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)

    graph_lines: list[str] = []
    concat_inputs: list[str] = []
    for index, (start, end) in enumerate(keep_ranges):
        graph_lines.append(
            f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[v{index}]"
        )
        graph_lines.append(
            f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a{index}]"
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
            "-movflags",
            "+faststart",
            str(destination),
        ]
        rendered = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_no_window_flag(),
        )
        if rendered.returncode != 0:
            raise RuntimeError(_last_lines(rendered.stderr or "فشل قص الصمت."))
    finally:
        Path(script_handle.name).unlink(missing_ok=True)
    return destination


def _probe(ffprobe: str | Path, source: Path) -> dict:
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
        creationflags=_no_window_flag(),
    )
    if result.returncode != 0:
        raise RuntimeError(_last_lines(result.stderr or "فشل قراءة الفيديو."))
    return json.loads(result.stdout)


def _last_lines(text: str, count: int = 8) -> str:
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    return "\n".join(lines[-count:]) or "حدث خطأ غير معروف."


def _no_window_flag() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
