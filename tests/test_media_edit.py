import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from media_edit import (
    _ffmpeg_telemetry_event,
    CaptionStyle,
    Overlay,
    build_caption_download_command,
    build_render_command,
    default_render_destination,
    download_arabic_captions,
    extract_preview_frame,
    fast_render_destination,
    parse_json3_cues,
    parse_srt_cues,
    resize_overlay,
    section_caption_window,
    sync_audio_timing,
    sync_audio_trim,
    write_clipped_ass,
)


class CaptionTests(unittest.TestCase):
    def test_caption_download_asks_for_manual_and_auto_arabic_subs(self):
        command = build_caption_download_command(
            yt_dlp="yt-dlp.exe",
            ffmpeg_dir="bin",
            url="https://youtu.be/example",
            output_dir="out",
        )
        self.assertIn("--skip-download", command)
        self.assertIn("--write-subs", command)
        self.assertIn("--write-auto-subs", command)
        self.assertEqual(command[command.index("--sub-langs") + 1], "ar.*")
        self.assertEqual(command[command.index("--sub-format") + 1], "json3")

    def test_caption_download_never_reuses_unrelated_stale_json3(self):
        with tempfile.TemporaryDirectory() as tmp:
            stale = Path(tmp) / "other-video.ar.json3"
            stale.write_text('{"events":[]}', encoding="utf-8")
            process = Mock()
            process.stdout = []
            process.wait.return_value = 0
            with patch("media_edit.subprocess.Popen", return_value=process):
                result = download_arabic_captions(
                    yt_dlp="yt-dlp.exe",
                    ffmpeg_dir="bin",
                    url="https://youtu.be/new-video",
                    output_dir=tmp,
                )
        self.assertIsNone(result)

    def test_json3_becomes_stable_non_overlapping_phrase_cues(self):
        payload = {
            "events": [
                {
                    "tStartMs": 1000,
                    "dDurationMs": 3000,
                    "segs": [{"utf8": "مرحبا"}, {"utf8": " بالعالم"}],
                },
                {"tStartMs": 2500, "dDurationMs": 2000, "segs": [{"utf8": ">> اختبار جديد"}]},
                {"tStartMs": 2600, "dDurationMs": 100, "aAppend": 1, "segs": [{"utf8": "\n"}]},
            ]
        }
        cues = parse_json3_cues(json.dumps(payload, ensure_ascii=False))
        self.assertEqual(cues[0].text, "مرحبا بالعالم")
        self.assertEqual(cues[0].end, 2.5)
        self.assertEqual(cues[1].text, "اختبار جديد")
        self.assertEqual(cues[1].start, 2.5)

    def test_clips_and_offsets_srt_into_bottom_center_ass(self):
        source = (
            "1\n00:01:00,000 --> 00:01:03,000\nمرحبا بالعالم\n\n"
            "2\n00:01:04,000 --> 00:01:07,000\nهذا اختبار\n\n"
        )
        cues = parse_srt_cues(source)
        self.assertEqual(len(cues), 2)
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "captions.ass"
            write_clipped_ass(
                cues=cues,
                clip_start=62.0,
                clip_end=66.0,
                destination=destination,
                video_width=1920,
                video_height=1080,
                font_family="Ping AR LT",
            )
            content = destination.read_text(encoding="utf-8")
        self.assertIn("WrapStyle: 0", content)
        self.assertIn("Alignment=2", content.replace(", ", ","))
        self.assertIn("MarginV=76", content.replace(", ", ","))
        self.assertIn("Shadow=2", content.replace(", ", ","))
        self.assertIn("0:00:00.00,0:00:01.00", content)
        self.assertIn("0:00:02.00,0:00:04.00", content)


class RenderTests(unittest.TestCase):
    def test_render_telemetry_parses_ffmpeg_block(self):
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
            stage="render",
        )
        self.assertAlmostEqual(event["percent"], 25.0)
        self.assertAlmostEqual(event["eta_seconds"], 5.0)
        self.assertAlmostEqual(event["fps"], 29.97)
        self.assertEqual(event["total_size"], 1048576.0)

    def test_preview_decodes_before_seeking_for_partial_downloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "preview.png"

            def fake_run(command, **_kwargs):
                self.assertLess(command.index("-i"), command.index("-ss"))
                destination.write_bytes(b"png")
                return Mock(returncode=0, stderr="")

            with patch("media_edit.subprocess.run", side_effect=fake_run):
                result = extract_preview_frame(
                    ffmpeg="ffmpeg.exe",
                    source="partial.webm",
                    timestamp=1.0,
                    destination=destination,
                )
        self.assertEqual(result.name, "preview.png")

    def test_locked_corner_resize_uses_vertical_drag_and_preserves_ratio_at_bounds(self):
        overlay = Overlay(kind="image", x=0.1, y=0.1, w=0.2, h=0.2, lock_aspect=True)
        resized = resize_overlay(
            overlay,
            handle="se",
            dx=0,
            dy=72,
            video_width=640,
            video_height=360,
        )
        self.assertGreater(resized.w, overlay.w)
        self.assertGreater(resized.h, overlay.h)
        before_ratio = (overlay.w * 640) / (overlay.h * 360)
        after_ratio = (resized.w * 640) / (resized.h * 360)
        self.assertAlmostEqual(after_ratio, before_ratio, places=6)

        edge = Overlay(kind="image", x=0.7, y=0.7, w=0.25, h=0.25, lock_aspect=True)
        bounded = resize_overlay(
            edge,
            handle="se",
            dx=500,
            dy=500,
            video_width=640,
            video_height=360,
        )
        self.assertLessEqual(bounded.x + bounded.w, 1.0)
        self.assertLessEqual(bounded.y + bounded.h, 1.0)
        edge_ratio = (edge.w * 640) / (edge.h * 360)
        bounded_ratio = (bounded.w * 640) / (bounded.h * 360)
        self.assertAlmostEqual(bounded_ratio, edge_ratio, places=6)

    def test_unlocked_side_resize_changes_only_requested_axis(self):
        overlay = Overlay(kind="image", x=0.1, y=0.1, w=0.2, h=0.2, lock_aspect=False)
        resized = resize_overlay(
            overlay,
            handle="e",
            dx=64,
            dy=0,
            video_width=640,
            video_height=360,
        )
        self.assertGreater(resized.w, overlay.w)
        self.assertAlmostEqual(resized.h, overlay.h, places=6)

    def test_partial_download_timeline_aligns_audio_and_caption_window_after_normalization(self):
        info = {
            "streams": [
                {"codec_type": "video", "start_time": "2.305"},
                {"codec_type": "audio", "start_time": "-0.007"},
            ],
            "format": {"start_time": "-0.007", "duration": "15.980"},
        }
        self.assertAlmostEqual(sync_audio_trim(info), 2.312, places=3)
        trim, delay = sync_audio_timing(info)
        self.assertAlmostEqual(trim, 2.312, places=3)
        self.assertAlmostEqual(delay, 0.0, places=3)
        command = build_render_command(
            ffmpeg="ffmpeg.exe",
            source=Path("talk.mkv"),
            destination=Path("talk_edited.mkv"),
            video_width=1920,
            video_height=1080,
            overlays=[],
            audio_trim_start=trim,
        )
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn(
            "[0:a]asetpts=PTS-STARTPTS,atrim=start=2.312000,asetpts=PTS-STARTPTS",
            graph,
        )
        normalized = {"format": {"duration": "8.708"}}
        start, end = section_caption_window(
            normalized,
            requested_start=90.0,
            requested_end=93.0,
        )
        self.assertAlmostEqual(start, 84.292, places=3)
        self.assertAlmostEqual(end, 93.0, places=3)

    def test_caption_window_is_exact_when_download_has_no_preroll(self):
        info = {"format": {"duration": "3.000"}}
        self.assertEqual(
            section_caption_window(
                info,
                requested_start=90.0,
                requested_end=93.0,
            ),
            (90.0, 93.0),
        )

    def test_audio_sync_normalizes_equal_positive_start_and_preserves_late_audio(self):
        equal = {
            "streams": [
                {"codec_type": "video", "start_time": "2.0"},
                {"codec_type": "audio", "start_time": "2.0"},
            ]
        }
        self.assertEqual(sync_audio_timing(equal), (0.0, 0.0))
        late = {
            "streams": [
                {"codec_type": "video", "start_time": "2.0"},
                {"codec_type": "audio", "start_time": "5.0"},
            ]
        }
        self.assertEqual(sync_audio_timing(late), (0.0, 3.0))
        command = build_render_command(
            ffmpeg="ffmpeg.exe",
            source=Path("talk.mkv"),
            destination=Path("talk_edited.mkv"),
            video_width=1920,
            video_height=1080,
            overlays=[],
            audio_delay_start=3.0,
        )
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn("asetpts=PTS-STARTPTS+3.000000/TB", graph)

    def test_caption_font_family_is_forced_at_render_time(self):
        command = build_render_command(
            ffmpeg="ffmpeg.exe",
            source=Path("talk.mkv"),
            destination=Path("talk_edited.mkv"),
            video_width=1920,
            video_height=1080,
            overlays=[],
            captions_ass=Path("captions.ass"),
            font_dir=Path("fonts"),
            caption_font_family="Different Font",
        )
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn("force_style='Fontname=Different Font,", graph)

    def test_caption_style_can_control_background_shadow_size_and_position(self):
        command = build_render_command(
            ffmpeg="ffmpeg.exe",
            source=Path("talk.mkv"),
            destination=Path("talk_edited.mp4"),
            video_width=1920,
            video_height=1080,
            overlays=[],
            captions_ass=Path("captions.ass"),
            caption_font_family="Ping AR + LT",
            caption_style=CaptionStyle(
                size_percent=6.0,
                text_color="#FFEEDD",
                outline_color="#112233",
                outline_width=2.5,
                shadow=3.0,
                background_enabled=True,
                background_color="#445566",
                background_opacity=60.0,
                position="top",
                horizontal="right",
                margin_percent=5.0,
                bold=True,
                italic=True,
            ),
        )
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn("Fontsize=65", graph)
        self.assertIn("BorderStyle=3", graph)
        self.assertIn("Shadow=3.00", graph)
        self.assertIn("Alignment=9", graph)
        self.assertIn("Bold=-1", graph)
        self.assertIn("Italic=-1", graph)

    def test_qsv_render_command_uses_hardware_encoder(self):
        command = build_render_command(
            ffmpeg="ffmpeg.exe",
            source=Path("talk.webm"),
            destination=Path("talk_edited.mp4"),
            video_width=1280,
            video_height=720,
            overlays=[],
            video_encoder="qsv",
        )
        self.assertIn("h264_qsv", command)
        self.assertIn("-global_quality", command)
        self.assertIn("nv12", command)

    def test_preserves_supported_container_in_default_destination(self):
        self.assertEqual(default_render_destination(Path("talk.mkv")).suffix, ".mkv")
        self.assertEqual(default_render_destination(Path("talk.mov")).suffix, ".mov")
        self.assertEqual(default_render_destination(Path("talk.webm")).suffix, ".webm")

    def test_fast_render_destination_is_mp4_even_for_webm_source(self):
        self.assertEqual(fast_render_destination(Path("talk.webm")).name, "talk_edited.mp4")

    def test_builds_image_black_bar_and_caption_render(self):
        overlays = [
            Overlay(kind="image", x=0.1, y=0.1, w=0.2, h=0.2, path=Path("logo.png")),
            Overlay(kind="bar", x=0.1, y=0.75, w=0.8, h=0.1),
        ]
        command = build_render_command(
            ffmpeg="ffmpeg.exe",
            source=Path("talk.mkv"),
            destination=Path("talk_edited.mkv"),
            video_width=1920,
            video_height=1080,
            overlays=overlays,
            captions_ass=Path("captions.ass"),
            font_dir=Path("fonts"),
        )
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn("overlay=", graph)
        self.assertIn("drawbox=", graph)
        self.assertIn("subtitles=", graph)
        self.assertIn("libx264", command)
        self.assertEqual(command[-1], "talk_edited.mkv")


if __name__ == "__main__":
    unittest.main()
