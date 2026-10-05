import unittest

from core import (
    build_download_command,
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
        section = command[command.index("--download-sections") + 1]
        self.assertEqual(section, "*00:01:05-00:02:05")
        self.assertIn("height<=720", command[command.index("-f") + 1])
        output_template = command[command.index("-o") + 1]
        self.assertIn("[00-01-05-00-02-05]", output_template)


class SilenceTests(unittest.TestCase):
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
