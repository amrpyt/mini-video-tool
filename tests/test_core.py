import tempfile
import unittest
from concurrent.futures import CancelledError
from pathlib import Path
from unittest.mock import Mock, patch

from core import (
    _copy_file_cancellable,
    _ffmpeg_telemetry_event,
    _probe,
    _run_ffmpeg_stream,
    aligned_stream_window,
    build_download_command,
    default_silence_destination,
    normalize_partial_download,
    download_section,
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
    def test_probe_exposes_process_for_cancellation(self):
        process = Mock()
        process.communicate.return_value = ('{"streams":[],"format":{}}', "")
        process.returncode = 0
        seen = []
        with patch("core.subprocess.Popen", return_value=process):
            info = _probe(
                "ffprobe.exe",
                Path("clip.mp4"),
                process_callback=seen.append,
            )
        self.assertEqual(info["streams"], [])
        self.assertEqual(seen, [process, None])

    def test_normalization_exposes_remux_process_for_cancellation(self):
        info = {
            "streams": [
                {"codec_type": "video", "start_time": "2.0"},
                {"codec_type": "audio", "start_time": "0.0"},
            ],
            "format": {"start_time": "0.0"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "clip.webm"
            source.write_bytes(b"original")
            (root / "ffmpeg.exe").write_bytes(b"x")
            (root / "ffprobe.exe").write_bytes(b"x")
            process = Mock()
            process.communicate.return_value = ("", "")
            process.returncode = 0
            seen = []

            def fake_popen(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized")
                return process

            with patch("core._probe", return_value=info), patch(
                "core.subprocess.Popen", side_effect=fake_popen
            ):
                result = normalize_partial_download(
                    ffmpeg_dir=root,
                    source=source,
                    process_callback=seen.append,
                )
            self.assertEqual(result.read_bytes(), b"normalized")
            self.assertEqual(seen, [process, None])

    def test_cancelled_download_removes_only_its_new_partial_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            existing = output / "keep-me.txt"
            existing.write_text("keep", encoding="utf-8")
            partial = output / "video [abc] [00-00-10-00-00-20] [720p].mp4.part"
            process = Mock()
            process.stdout = iter([])
            process.poll.return_value = None

            def fake_popen(*_args, **_kwargs):
                partial.write_bytes(b"partial")
                return process

            with patch("core.subprocess.Popen", side_effect=fake_popen):
                with self.assertRaises(CancelledError):
                    download_section(
                        yt_dlp="yt-dlp.exe",
                        ffmpeg_dir="bin",
                        url="https://youtu.be/abc",
                        start=10.0,
                        end=20.0,
                        quality="720p",
                        output_dir=output,
                        cancel_requested=lambda: True,
                    )
            self.assertTrue(existing.exists())
            self.assertFalse(partial.exists())

    def test_cancel_during_normalization_preserves_completed_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            final_file = output / "video [abc] [00-00-10-00-00-20] [720p].mp4"
            process = Mock()
            process.poll.return_value = 0
            process.wait.return_value = 0

            def stdout_lines():
                final_file.write_bytes(b"complete-video")
                yield f"FINAL_FILE:{final_file}"

            process.stdout = stdout_lines()
            with patch("core.subprocess.Popen", return_value=process), patch(
                "core.normalize_partial_download", side_effect=CancelledError
            ):
                with self.assertRaises(CancelledError):
                    download_section(
                        yt_dlp="yt-dlp.exe",
                        ffmpeg_dir="bin",
                        url="https://youtu.be/abc",
                        start=10.0,
                        end=20.0,
                        quality="720p",
                        output_dir=output,
                    )
            self.assertTrue(final_file.exists())
            self.assertEqual(final_file.read_bytes(), b"complete-video")

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
        self.assertIn("--downloader-args", command)
        self.assertIn("-progress pipe:1", command[command.index("--downloader-args") + 1])
        progress_template = command[command.index("--progress-template") + 1]
        self.assertIn("progress.downloaded_bytes", progress_template)
        self.assertIn("progress.total_bytes_estimate", progress_template)
        self.assertIn("progress.speed", progress_template)
        section = command[command.index("--download-sections") + 1]
        self.assertEqual(section, "*00:01:05-00:02:05")
        selected_format = command[command.index("-f") + 1]
        self.assertIn("height<=720", selected_format)
        self.assertIn("protocol*=m3u8", selected_format)
        self.assertIn("vcodec^=avc1", selected_format)
        output_template = command[command.index("-o") + 1]
        self.assertIn("[00-01-05-00-02-05]", output_template)
        self.assertIn("[720p]", output_template)

    def test_best_quality_does_not_cap_itself_to_hls_ladder(self):
        command = build_download_command(
            yt_dlp="yt-dlp.exe",
            ffmpeg_dir="bin",
            url="https://youtu.be/example",
            start=10.0,
            end=20.0,
            quality="أفضل جودة متاحة",
            output_dir="out",
        )
        selected_format = command[command.index("-f") + 1]
        self.assertEqual(selected_format, "bv*+ba/b")

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

            def fake_popen(command, **_kwargs):
                self.assertIn("copy", command)
                self.assertNotIn("libx264", command)
                self.assertAlmostEqual(float(command[command.index("-ss") + 1]), 8.279, places=3)
                Path(command[-1]).write_bytes(b"normalized")
                process = Mock()
                process.communicate.return_value = ("", "")
                process.returncode = 0
                return process

            with patch("core._probe", return_value=info), patch("core.subprocess.Popen", side_effect=fake_popen):
                result = normalize_partial_download(ffmpeg_dir=root, source=source)

            self.assertEqual(result, source.resolve())
            self.assertEqual(source.read_bytes(), b"normalized")


class SilenceTests(unittest.TestCase):
    def test_large_plain_copy_can_be_cancelled_between_chunks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.bin"
            destination = root / "destination.bin"
            source.write_bytes(b"a" * (2 * 1024 * 1024))
            checks = {"count": 0}

            def cancelled():
                checks["count"] += 1
                return checks["count"] >= 3

            with self.assertRaises(CancelledError):
                _copy_file_cancellable(
                    source,
                    destination,
                    cancel_requested=cancelled,
                    chunk_size=512 * 1024,
                )
            self.assertLess(destination.stat().st_size, source.stat().st_size)

    def test_streaming_ffmpeg_exposes_active_process_for_cancellation(self):
        process = Mock()
        process.stdout = iter([])
        process.wait.return_value = 0
        seen = []
        with patch("core.subprocess.Popen", return_value=process):
            code, _text = _run_ffmpeg_stream(
                ["ffmpeg.exe"],
                duration=1.0,
                stage="silence_analyze",
                process_callback=seen.append,
            )
        self.assertEqual(code, 0)
        self.assertEqual(seen, [process, None])

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
