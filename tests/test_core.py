import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from core import (
    _ffmpeg_telemetry_event,
    aligned_stream_window,
    build_download_command,
    default_silence_destination,
    normalize_partial_download,
    parse_download_progress,
    parse_download_telemetry,
    parse_silence_intervals,
    parse_timecode,
    silence_to_keep_ranges,
)


class TimeParsingTests(unittest.TestCase):
    def test_accepts_hh_mm_ss_and_mm_ss(self):
        self.assertEqual(parse_timecode("01:02:03"), 3723.0)
        self.assertEqual(parse_timecode("02:30"), 150.0)
        self.assertEqual(parse_timecode("12.5"), 12.5)

    def test_rejects_bad_time(self):
        with self.assertRaises(ValueError):
            parse_timecode("1:99")


class DownloadCommandTests(unittest.TestCase):
    def test_builds_partial_download_with_requested_quality(self):
        command = build_download_command(
            yt_dlp="yt-dlp.exe",
            ffmpeg_dir="bin",
            url="https://youtu.be/example",
            start=65.0,
            end=125.0,
            quality="720p",
            output_dir="out",
        )
        self.assertIn("--download-sections", command)
        self.assertIn("--progress", command)
        self.assertIn("--newline", command)
        progress_template = command[command.index("--progress-template") + 1]
        self.assertIn("progress.downloaded_bytes", progress_template)
        self.assertIn("progress.total_bytes_estimate", progress_template)
        self.assertIn("progress.speed", progress_template)
        section = command[command.index("--download-sections") + 1]
        self.assertEqual(section, "*00:01:05-00:02:05")
        self.assertIn("height<=720", command[command.index("-f") + 1])
        output_template = command[command.index("-o") + 1]
        self.assertIn("[00-01-05-00-02-05]", output_template)
        self.assertIn("[720p]", output_template)

    def test_parses_machine_readable_progress(self):
        self.assertEqual(
            parse_download_progress("PROGRESS:42.5|1.2MiB/s|00:08"),
            (42.5, "1.2MiB/s", "00:08"),
        )

    def test_parses_rich_download_telemetry_and_na(self):
        telemetry = parse_download_telemetry(
            "PROGRESS:42.5|1.2MiB/s|00:08|1048576|2097152|NA|3.5|1258291.2"
        )
        self.assertEqual(telemetry["percent"], 42.5)
        self.assertEqual(telemetry["downloaded_bytes"], 1048576.0)
        self.assertEqual(telemetry["total_bytes"], 2097152.0)
        self.assertIsNone(telemetry["total_bytes_estimate"])
        self.assertEqual(telemetry["elapsed"], 3.5)
        self.assertAlmostEqual(telemetry["speed"], 1258291.2)

    def test_normalizes_audio_preroll_with_stream_copy_only(self):
        info = {
            "streams": [
                {"codec_type": "video", "start_time": "8.272"},
                {"codec_type": "audio", "start_time": "-0.007"},
            ],
            "format": {"start_time": "-0.007"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "clip.webm"
            source.write_bytes(b"original")
            (root / "ffmpeg.exe").write_bytes(b"x")
            (root / "ffprobe.exe").write_bytes(b"x")

            def fake_run(command, **_kwargs):
                self.assertIn("copy", command)
                self.assertNotIn("libx264", command)
                self.assertAlmostEqual(float(command[command.index("-ss") + 1]), 8.279, places=3)
                Path(command[-1]).write_bytes(b"normalized")
                return Mock(returncode=0, stderr="")

            with patch("core._probe", return_value=info), patch("core.subprocess.run", side_effect=fake_run):
                result = normalize_partial_download(ffmpeg_dir=root, source=source)

            self.assertEqual(result, source.resolve())
            self.assertEqual(source.read_bytes(), b"normalized")


class SilenceTests(unittest.TestCase):
    def test_ffmpeg_telemetry_has_real_percent_eta_and_size(self):
        event = _ffmpeg_telemetry_event(
            {
                "out_time_us": "2500000",
                "fps": "29.97",
                "speed": "1.5x",
                "total_size": "1048576",
                "bitrate": "3355.4kbits/s",
                "progress": "continue",
            },
            duration=10.0,
            stage="silence_analyze",
        )
        self.assertAlmostEqual(event["percent"], 25.0)
        self.assertAlmostEqual(event["eta_seconds"], 5.0)
        self.assertAlmostEqual(event["fps"], 29.97)
        self.assertEqual(event["total_size"], 1048576.0)
    def test_aligns_mismatched_stream_starts_before_silence_cut(self):
        info = {
            "streams": [
                {"codec_type": "video", "start_time": "2.305"},
                {"codec_type": "audio", "start_time": "-0.007"},
            ],
            "format": {"start_time": "-0.007", "duration": "15.980"},
        }
        video_offset, audio_offset, duration = aligned_stream_window(info)
        self.assertAlmostEqual(video_offset, 0.0, places=3)
        self.assertAlmostEqual(audio_offset, 2.312, places=3)
        self.assertAlmostEqual(duration, 13.668, places=3)

    def test_silence_output_preserves_supported_container(self):
        self.assertEqual(default_silence_destination(__import__("pathlib").Path("x.mkv")).suffix, ".mkv")
        self.assertEqual(default_silence_destination(__import__("pathlib").Path("x.mov")).suffix, ".mov")
        self.assertEqual(default_silence_destination(__import__("pathlib").Path("x.webm")).suffix, ".webm")

    def test_parses_silencedetect_output(self):
        text = """
        [silencedetect @ x] silence_start: 2
        [silencedetect @ x] silence_end: 4.5 | silence_duration: 2.5
        [silencedetect @ x] silence_start: 8
        [silencedetect @ x] silence_end: 9 | silence_duration: 1
        """
        self.assertEqual(parse_silence_intervals(text), [(2.0, 4.5), (8.0, 9.0)])

    def test_keeps_margin_around_speech(self):
        keep = silence_to_keep_ranges(
            duration=12.0,
            silence_intervals=[(2.0, 4.5), (8.0, 9.0)],
            margin=0.2,
        )
        self.assertEqual(keep, [(0.0, 2.2), (4.3, 8.2), (8.8, 12.0)])


if __name__ == "__main__":
    unittest.main()
