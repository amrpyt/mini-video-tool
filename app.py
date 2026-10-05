from __future__ import annotations

import shutil
import sys
import tempfile
import threading
import tkinter as tk
import queue
from dataclasses import replace
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageFont, ImageTk

from core import QUALITY_FORMATS, cut_silence, download_section, parse_timecode
from media_edit import (
    Overlay,
    captions_for_section,
    default_render_destination,
    download_arabic_captions,
    extract_preview_frame,
    probe_media,
    render_video,
    resize_overlay,
    section_caption_window,
    video_geometry,
)


APP_TITLE = "Mini Video Tool"
HANDLE_SIZE = 8


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def binary(name: str) -> Path:
    local = app_dir() / "bin" / name
    if local.is_file():
        return local
    found = shutil.which(name)
    if found:
        return Path(found)
    raise FileNotFoundError(f"ملف {name} غير موجود داخل مجلد bin.")


def discover_caption_font() -> Path | None:
    home = Path.home()
    candidates = [
        home / "Downloads",
        home / ".codex-config-backup" / "project-source-backup",
    ]
    patterns = ("*PingARLT-Regular*.otf", "*PingARLT-Regular*.ttf", "*Ping*AR*LT*Regular*.otf")
    for root in candidates:
        if not root.exists():
            continue
        for pattern in patterns:
            try:
                match = next(root.rglob(pattern))
            except StopIteration:
                continue
            if match.is_file():
                return match.resolve()
    fallback = Path(r"C:\Windows\Fonts\sf-arabic-regular.ttf")
    return fallback if fallback.is_file() else None


def font_family(path: Path | None) -> str:
    if path and path.is_file():
        try:
            return str(ImageFont.truetype(str(path), 20).getname()[0])
        except Exception:
            pass
    return "Arial"


class MiniVideoTool(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.busy = False
        self.ui_queue: queue.Queue[tuple[object, tuple]] = queue.Queue()
        self.action_buttons: list[ttk.Button] = []
        self.busy_controls: list[tuple[tk.Widget, str]] = []
        self.caption_font_path = discover_caption_font()
        self.overlays: list[Overlay] = []
        self.selected_overlay: int | None = None
        self.drag_state: tuple[str, int, float, float, Overlay] | None = None
        self.preview_original: Image.Image | None = None
        self.preview_photo: ImageTk.PhotoImage | None = None
        self.overlay_photos: list[ImageTk.PhotoImage] = []
        self.image_cache: dict[Path, Image.Image] = {}
        self.video_width = 0
        self.video_height = 0
        self.video_duration = 0.0
        self.preview_generation = 0
        self.preview_rect = (0.0, 0.0, 1.0, 1.0)
        self.temp_root = Path(tempfile.gettempdir()) / "MiniVideoTool"
        self.temp_root.mkdir(parents=True, exist_ok=True)

        self.title(APP_TITLE)
        self.geometry("1120x820")
        self.minsize(940, 700)
        self.configure(bg="#f4f4f4")
        self.option_add("*Font", ("Segoe UI", 10))
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(40, self._drain_ui_queue)

    def _build(self) -> None:
        outer = ttk.Frame(self, padding=16)
        outer.pack(fill="both", expand=True)

        header = ttk.Frame(outer)
        header.pack(fill="x")
        ttk.Label(header, text="Mini Video Tool", font=("Segoe UI Semibold", 19)).pack(anchor="e")
        ttk.Label(
            header,
            text="تحميل جزء • قص صمت • صور وكابشن — من غير زحمة.",
            foreground="#666666",
        ).pack(anchor="e", pady=(2, 10))

        self.tabs = ttk.Notebook(outer)
        self.tabs.pack(fill="both", expand=True)
        download_tab = ttk.Frame(self.tabs, padding=16)
        silence_tab = ttk.Frame(self.tabs, padding=16)
        editor_tab = ttk.Frame(self.tabs, padding=12)
        self.tabs.add(download_tab, text="تحميل جزء")
        self.tabs.add(silence_tab, text="قص الصمت")
        self.tabs.add(editor_tab, text="صور + كابشن")

        self._build_download(download_tab)
        self._build_silence(silence_tab)
        self._build_editor(editor_tab)
        self._build_activity(outer)

    def _build_download(self, parent: ttk.Frame) -> None:
        self.url_var = tk.StringVar()
        self.start_var = tk.StringVar(value="00:00:00")
        self.end_var = tk.StringVar(value="00:01:00")
        self.quality_var = tk.StringVar(value="أفضل جودة متاحة")
        self.output_var = tk.StringVar(value=str(Path.home() / "Downloads"))
        self.download_captions_var = tk.BooleanVar(value=False)

        self._label(parent, "رابط يوتيوب").pack(fill="x")
        ttk.Entry(parent, textvariable=self.url_var, justify="right").pack(fill="x", pady=(4, 12))

        times = ttk.Frame(parent)
        times.pack(fill="x", pady=(0, 12))
        times.columnconfigure((0, 1), weight=1)
        end_box = ttk.Frame(times)
        end_box.grid(row=0, column=0, sticky="ew", padx=(0, 6))
        start_box = ttk.Frame(times)
        start_box.grid(row=0, column=1, sticky="ew", padx=(6, 0))
        self._label(end_box, "إلى").pack(fill="x")
        ttk.Entry(end_box, textvariable=self.end_var, justify="center").pack(fill="x", pady=(4, 0))
        self._label(start_box, "من").pack(fill="x")
        ttk.Entry(start_box, textvariable=self.start_var, justify="center").pack(fill="x", pady=(4, 0))

        self._label(parent, "الجودة").pack(fill="x")
        ttk.Combobox(
            parent,
            textvariable=self.quality_var,
            values=list(QUALITY_FORMATS),
            state="readonly",
            justify="right",
        ).pack(fill="x", pady=(4, 4))
        ttk.Label(
            parent,
            text="أفضل جودة = أعلى جودة متاحة من يوتيوب. الأداة لا تجبر الملف على MP4.",
            foreground="#6f6f6f",
        ).pack(anchor="e")
        ttk.Label(
            parent,
            text="حدود الجزء تقريبية حسب keyframes للحفاظ على السرعة والجودة بدون إعادة ترميز.",
            foreground="#6f6f6f",
        ).pack(anchor="e", pady=(2, 10))

        ttk.Checkbutton(
            parent,
            text="حمّل كابشن يوتيوب العربي مع الجزء (اختياري)",
            variable=self.download_captions_var,
        ).pack(anchor="e", pady=(0, 12))

        self._label(parent, "مكان الحفظ").pack(fill="x")
        output_row = ttk.Frame(parent)
        output_row.pack(fill="x", pady=(4, 16))
        ttk.Button(output_row, text="اختيار", command=self._choose_output).pack(side="left")
        ttk.Entry(output_row, textvariable=self.output_var, justify="right").pack(
            side="right", fill="x", expand=True, padx=(8, 0)
        )

        self.download_button = self._action_button(parent, "تحميل الجزء", self._download)
        self.download_button.pack(fill="x", ipady=7)

    def _build_silence(self, parent: ttk.Frame) -> None:
        self.silence_source_var = tk.StringVar()
        ttk.Label(
            parent,
            text="اختار فيديو. هنكتشف الصمت ونشيله مع هامش 0.2 ثانية حوالين الكلام.",
            justify="right",
        ).pack(anchor="e", pady=(0, 14))
        self._label(parent, "الفيديو").pack(fill="x")
        row = ttk.Frame(parent)
        row.pack(fill="x", pady=(4, 16))
        ttk.Button(row, text="اختيار", command=self._choose_silence_video).pack(side="left")
        ttk.Entry(row, textvariable=self.silence_source_var, justify="right").pack(
            side="right", fill="x", expand=True, padx=(8, 0)
        )
        self.silence_button = self._action_button(parent, "قص الصمت", self._cut_silence)
        self.silence_button.pack(fill="x", ipady=7)

    def _build_editor(self, parent: ttk.Frame) -> None:
        self.editor_source_var = tk.StringVar()
        self.caption_file_var = tk.StringVar()
        self.captions_enabled_var = tk.BooleanVar(value=False)
        self.lock_aspect_var = tk.BooleanVar(value=True)
        self.selected_label_var = tk.StringVar(value="لا يوجد عنصر محدد")
        self.preview_time_var = tk.DoubleVar(value=0.0)
        self.preview_time_text = tk.StringVar(value="00:00")
        self.font_label_var = tk.StringVar(value=self._font_display_text())

        source_row = ttk.Frame(parent)
        source_row.pack(fill="x", pady=(0, 8))
        self.editor_source_button = ttk.Button(
            source_row, text="اختيار فيديو", command=self._choose_editor_video
        )
        self.editor_source_button.pack(side="left")
        self._busy_control(self.editor_source_button)
        ttk.Entry(
            source_row,
            textvariable=self.editor_source_var,
            justify="right",
            state="readonly",
        ).pack(
            side="right", fill="x", expand=True, padx=(8, 0)
        )

        body = ttk.Frame(parent)
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=1)
        body.rowconfigure(0, weight=1)

        canvas_box = ttk.Frame(body)
        canvas_box.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        controls = ttk.Frame(body, width=270)
        controls.grid(row=0, column=1, sticky="ns")

        self.canvas = tk.Canvas(
            canvas_box,
            bg="#181818",
            highlightthickness=1,
            highlightbackground="#bdbdbd",
            cursor="arrow",
        )
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _event: self._redraw_canvas())
        self.canvas.bind("<Button-1>", self._canvas_press)
        self.canvas.bind("<B1-Motion>", self._canvas_drag)
        self.canvas.bind("<ButtonRelease-1>", lambda _event: setattr(self, "drag_state", None))

        preview_row = ttk.Frame(canvas_box)
        preview_row.pack(fill="x", pady=(8, 0))
        ttk.Label(preview_row, textvariable=self.preview_time_text, width=9).pack(side="left")
        self.preview_scale = ttk.Scale(
            preview_row,
            from_=0,
            to=1,
            variable=self.preview_time_var,
            command=self._preview_slider_changed,
        )
        self.preview_scale.pack(side="left", fill="x", expand=True, padx=8)
        self._busy_control(self.preview_scale)
        self.preview_button = self._action_button(preview_row, "تحديث اللقطة", self._refresh_preview)
        self.preview_button.pack(side="right")

        self._label(controls, "العناصر").pack(fill="x")
        ttk.Label(controls, textvariable=self.selected_label_var, foreground="#666666").pack(
            anchor="e", pady=(2, 8)
        )
        self.add_image_button = self._action_button(controls, "إضافة صورة / PNG", self._add_image)
        self.add_image_button.pack(fill="x", pady=2)
        self.add_bar_button = self._action_button(controls, "إضافة شريط أسود", self._add_black_bar)
        self.add_bar_button.pack(fill="x", pady=2)
        self.delete_overlay_button = self._action_button(controls, "حذف العنصر المحدد", self._delete_overlay)
        self.delete_overlay_button.pack(fill="x", pady=(2, 8))
        self.aspect_lock_check = ttk.Checkbutton(
            controls,
            text="🔒 الحفاظ على نسبة العرض/الارتفاع",
            variable=self.lock_aspect_var,
            command=self._toggle_aspect_lock,
        )
        self.aspect_lock_check.pack(anchor="e", pady=(0, 14))
        self._busy_control(self.aspect_lock_check)
        ttk.Label(
            controls,
            text="مقفول: التحجيم Uniform. مفتوح: تقدر تمد العرض أو الارتفاع لوحده.",
            foreground="#777777",
            wraplength=250,
            justify="right",
        ).pack(anchor="e", pady=(0, 14))

        ttk.Separator(controls).pack(fill="x", pady=5)
        self._label(controls, "الكابشن").pack(fill="x", pady=(5, 0))
        self.caption_enable_check = ttk.Checkbutton(
            controls,
            text="حرق الكابشن في الفيديو",
            variable=self.captions_enabled_var,
        )
        self.caption_enable_check.pack(anchor="e", pady=(2, 6))
        self._busy_control(self.caption_enable_check)
        self.caption_entry = ttk.Entry(controls, textvariable=self.caption_file_var, justify="right")
        self.caption_entry.pack(fill="x")
        self._busy_control(self.caption_entry)
        self.caption_file_button = ttk.Button(
            controls, text="اختيار ملف الكابشن", command=self._choose_caption_file
        )
        self.caption_file_button.pack(fill="x", pady=(4, 8))
        self._busy_control(self.caption_file_button)
        ttk.Label(controls, textvariable=self.font_label_var, foreground="#666666", wraplength=250).pack(
            anchor="e"
        )
        self.font_button = ttk.Button(controls, text="اختيار خط", command=self._choose_font)
        self.font_button.pack(fill="x", pady=(4, 12))
        self._busy_control(self.font_button)
        self._busy_control(self.canvas)

        ttk.Separator(controls).pack(fill="x", pady=5)
        self.render_button = self._action_button(controls, "إخراج الفيديو", self._render_editor_video)
        self.render_button.pack(fill="x", ipady=6, pady=(10, 0))

    def _build_activity(self, parent: ttk.Frame) -> None:
        box = ttk.LabelFrame(parent, text="اللي بيحصل دلوقتي", padding=(10, 8))
        box.pack(fill="x", pady=(10, 0))
        top = ttk.Frame(box)
        top.pack(fill="x")
        self.activity_var = tk.StringVar(value="جاهز")
        ttk.Label(top, textvariable=self.activity_var).pack(side="right")
        self.progress = ttk.Progressbar(top, mode="determinate", maximum=100, value=0)
        self.progress.pack(side="left", fill="x", expand=True, padx=(0, 12))
        self.log_text = tk.Text(box, height=4, wrap="word", state="disabled", bg="#fafafa", relief="flat")
        self.log_text.pack(fill="x", pady=(7, 0))

    @staticmethod
    def _label(parent: ttk.Frame, text: str) -> ttk.Label:
        return ttk.Label(parent, text=text, font=("Segoe UI Semibold", 10), anchor="e")

    def _action_button(self, parent: ttk.Frame, text: str, command) -> ttk.Button:
        button = ttk.Button(parent, text=text, command=command)
        self.action_buttons.append(button)
        return button

    def _busy_control(self, widget: tk.Widget, normal_state: str = "normal") -> None:
        self.busy_controls.append((widget, normal_state))

    def _choose_output(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.output_var.get() or str(Path.home()))
        if selected:
            self.output_var.set(selected)

    def _choose_silence_video(self) -> None:
        selected = self._ask_video()
        if selected:
            self.silence_source_var.set(selected)

    def _choose_editor_video(self) -> None:
        selected = self._ask_video()
        if selected:
            self.editor_source_var.set(selected)
            self.caption_file_var.set("")
            self.captions_enabled_var.set(False)
            self._load_editor_source(Path(selected))

    @staticmethod
    def _ask_video() -> str:
        return filedialog.askopenfilename(
            filetypes=[
                ("Video", "*.mp4 *.mkv *.mov *.webm *.avi *.m4v"),
                ("All files", "*.*"),
            ]
        )

    def _download(self) -> None:
        if self.busy:
            return
        try:
            url = self.url_var.get().strip()
            if not url:
                raise ValueError("حط رابط يوتيوب.")
            start = parse_timecode(self.start_var.get())
            end = parse_timecode(self.end_var.get())
            if end <= start:
                raise ValueError("وقت النهاية لازم يكون بعد البداية.")
            output = Path(self.output_var.get()).expanduser()
            quality = self.quality_var.get()
            want_captions = bool(self.download_captions_var.get())
            yt_dlp = binary("yt-dlp.exe")
            ffmpeg = binary("ffmpeg.exe")
            ffprobe = binary("ffprobe.exe")
            caption_font = self.caption_font_path
            caption_family = font_family(caption_font)
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        def work():
            self._thread_status("تحميل الجزء المطلوب فقط من يوتيوب...", indeterminate=True)
            video = download_section(
                yt_dlp=yt_dlp,
                ffmpeg_dir=ffmpeg.parent,
                url=url,
                start=start,
                end=end,
                quality=quality,
                output_dir=output,
                progress_callback=self._thread_download_progress,
                log_callback=self._thread_log,
            )
            caption_file = None
            if want_captions:
                self._thread_status("تحميل كابشن يوتيوب العربي...", indeterminate=True)
                with tempfile.TemporaryDirectory(prefix="captions-", dir=self.temp_root) as raw_temp:
                    srt = download_arabic_captions(
                        yt_dlp=yt_dlp,
                        ffmpeg_dir=ffmpeg.parent,
                        url=url,
                        output_dir=Path(raw_temp),
                        log_callback=self._thread_log,
                    )
                    if srt:
                        info = probe_media(ffprobe, video)
                        width, height, _duration = video_geometry(info)
                        caption_start, caption_end = section_caption_window(
                            info,
                            requested_start=start,
                            requested_end=end,
                        )
                        caption_file = video.with_name(f"{video.stem}.captions.ass")
                        captions_for_section(
                            srt_path=srt,
                            clip_start=caption_start,
                            clip_end=caption_end,
                            destination=caption_file,
                            video_width=width,
                            video_height=height,
                            font_family=caption_family,
                        )
                        self._thread_log(f"الكابشن جاهز: {caption_file.name}")
                    else:
                        self._thread_log("مفيش كابشن عربي متاح للفيديو ده.")
            return video, caption_file

        self._start_job("جاري التحميل...", work, self._download_finished, indeterminate=True)

    def _download_finished(self, result) -> None:
        video, caption_file = result
        self.editor_source_var.set(str(video))
        if caption_file:
            self.caption_file_var.set(str(caption_file))
            self.captions_enabled_var.set(True)
        else:
            self.caption_file_var.set("")
            self.captions_enabled_var.set(False)
        self._load_editor_source(video, extract_now=False)
        messagebox.showinfo(APP_TITLE, f"تم التحميل.\n{video}")

    def _cut_silence(self) -> None:
        if self.busy:
            return
        try:
            source = Path(self.silence_source_var.get()).expanduser()
            if not source.is_file():
                raise ValueError("اختار فيديو صحيح.")
            ffmpeg = binary("ffmpeg.exe")
            ffprobe = binary("ffprobe.exe")
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        def work():
            self._thread_status("تحليل الصمت...", indeterminate=True)
            return cut_silence(
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                source=source,
                status_callback=lambda text: self._thread_status(text, indeterminate=True),
            )

        self._start_job("تحليل الصمت...", work, self._silence_finished, indeterminate=True)

    def _silence_finished(self, result: Path) -> None:
        messagebox.showinfo(APP_TITLE, f"تم قص الصمت.\n{result}")

    def _load_editor_source(self, source: Path, *, extract_now: bool = True) -> None:
        self.preview_generation += 1
        self.preview_original = None
        self.preview_photo = None
        self.overlay_photos.clear()
        self.video_width = 0
        self.video_height = 0
        self.video_duration = 0.0
        self.preview_time_var.set(0.0)
        self.preview_scale.configure(to=1)
        self.overlays.clear()
        self.selected_overlay = None
        self._sync_selected_overlay_ui()
        self._update_preview_time_text()
        self._redraw_canvas()
        source = Path(source).resolve()
        generation = self.preview_generation
        try:
            ffprobe = binary("ffprobe.exe")
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        def work():
            info = probe_media(ffprobe, source)
            width, height, duration = video_geometry(info)
            return source, generation, width, height, duration, extract_now

        self._start_job("قراءة معلومات الفيديو...", work, self._editor_source_loaded, indeterminate=True)

    def _editor_source_loaded(self, result) -> None:
        source, generation, width, height, duration, extract_now = result
        try:
            current_source = Path(self.editor_source_var.get()).resolve()
        except OSError:
            return
        if generation != self.preview_generation or current_source != source:
            self._log("تم تجاهل معلومات فيديو قديمة لأن المصدر اتغير.")
            return
        self.video_width, self.video_height, self.video_duration = width, height, duration
        self.preview_scale.configure(to=max(0.001, duration))
        self.preview_time_var.set(0.0)
        self._update_preview_time_text()
        if extract_now:
            self._refresh_preview()

    def _refresh_preview(self) -> None:
        if self.busy:
            return
        source = Path(self.editor_source_var.get())
        if not source.is_file():
            messagebox.showerror(APP_TITLE, "اختار فيديو الأول.")
            return
        timestamp = float(self.preview_time_var.get())
        generation = self.preview_generation
        source_identity = source.resolve()
        ffmpeg = binary("ffmpeg.exe")
        destination = self.temp_root / "preview.png"

        def work():
            self._thread_status(f"استخراج لقطة عند {self._format_short_time(timestamp)}...", indeterminate=True)
            frame_path = extract_preview_frame(
                ffmpeg=ffmpeg,
                source=source,
                timestamp=timestamp,
                destination=destination,
            )
            return frame_path, source_identity, timestamp, generation

        self._start_job("استخراج لقطة المعاينة...", work, self._preview_finished, indeterminate=True)

    def _preview_finished(self, result) -> None:
        frame_path, source_identity, timestamp, generation = result
        try:
            current_source = Path(self.editor_source_var.get()).resolve()
        except OSError:
            return
        if generation != self.preview_generation or current_source != source_identity:
            self._log("تم تجاهل لقطة معاينة قديمة لأن الفيديو اتغير.")
            return
        if abs(float(self.preview_time_var.get()) - float(timestamp)) > 0.01:
            self._log("تم تجاهل لقطة معاينة قديمة لأن التوقيت اتغير.")
            return
        with Image.open(frame_path) as image:
            self.preview_original = image.convert("RGB").copy()
        self._redraw_canvas()

    def _preview_slider_changed(self, _value: str) -> None:
        self._update_preview_time_text()

    def _update_preview_time_text(self) -> None:
        self.preview_time_text.set(self._format_short_time(float(self.preview_time_var.get())))

    def _add_image(self) -> None:
        if self.video_width <= 0:
            messagebox.showerror(APP_TITLE, "اختار فيديو واعمل لقطة معاينة الأول.")
            return
        selected = filedialog.askopenfilename(
            filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.bmp"), ("All files", "*.*")]
        )
        if not selected:
            return
        path = Path(selected).resolve()
        try:
            image = Image.open(path)
            image.load()
            iw, ih = image.size
            self.image_cache[path] = image.convert("RGBA")
        except Exception as exc:
            messagebox.showerror(APP_TITLE, f"تعذر فتح الصورة:\n{exc}")
            return
        w = 0.22
        h = w * (ih / max(1, iw)) * (self.video_width / self.video_height)
        h = min(0.5, max(0.04, h))
        overlay = Overlay(kind="image", path=path, x=0.04, y=0.04, w=w, h=h, lock_aspect=True)
        self.overlays.append(overlay)
        self.selected_overlay = len(self.overlays) - 1
        self._sync_selected_overlay_ui()
        self._redraw_canvas()

    def _add_black_bar(self) -> None:
        if self.video_width <= 0:
            messagebox.showerror(APP_TITLE, "اختار فيديو واعمل لقطة معاينة الأول.")
            return
        self.overlays.append(
            Overlay(kind="bar", x=0.08, y=0.76, w=0.84, h=0.12, lock_aspect=False)
        )
        self.selected_overlay = len(self.overlays) - 1
        self._sync_selected_overlay_ui()
        self._redraw_canvas()

    def _delete_overlay(self) -> None:
        if self.selected_overlay is None:
            return
        if 0 <= self.selected_overlay < len(self.overlays):
            self.overlays.pop(self.selected_overlay)
        self.selected_overlay = None
        self._sync_selected_overlay_ui()
        self._redraw_canvas()

    def _toggle_aspect_lock(self) -> None:
        if self.selected_overlay is None:
            return
        overlay = self.overlays[self.selected_overlay]
        overlay.lock_aspect = bool(self.lock_aspect_var.get())
        self._sync_selected_overlay_ui()

    def _sync_selected_overlay_ui(self) -> None:
        if self.selected_overlay is None or self.selected_overlay >= len(self.overlays):
            self.selected_label_var.set("لا يوجد عنصر محدد")
            self.lock_aspect_var.set(True)
            return
        overlay = self.overlays[self.selected_overlay]
        if overlay.kind == "bar":
            name = "شريط أسود"
        else:
            name = overlay.path.name if overlay.path else "صورة"
        self.selected_label_var.set(name)
        self.lock_aspect_var.set(overlay.lock_aspect)

    def _choose_caption_file(self) -> None:
        selected = filedialog.askopenfilename(
            filetypes=[("ASS captions", "*.ass"), ("All files", "*.*")]
        )
        if selected:
            self.caption_file_var.set(selected)
            self.captions_enabled_var.set(True)

    def _choose_font(self) -> None:
        selected = filedialog.askopenfilename(
            filetypes=[("Fonts", "*.otf *.ttf"), ("All files", "*.*")]
        )
        if selected:
            self.caption_font_path = Path(selected).resolve()
            self.font_label_var.set(self._font_display_text())

    def _font_display_text(self) -> str:
        if self.caption_font_path:
            return f"خط الكابشن: {font_family(self.caption_font_path)}"
        return "خط الكابشن: Arial (لم يتم العثور على Ping AR LT)"

    def _render_editor_video(self) -> None:
        if self.busy:
            return
        try:
            source = Path(self.editor_source_var.get()).resolve()
            if not source.is_file():
                raise ValueError("اختار فيديو الأول.")
            captions = None
            font_dir = None
            caption_family = None
            if self.captions_enabled_var.get():
                captions = Path(self.caption_file_var.get()).resolve()
                if not captions.is_file():
                    raise ValueError("فعّلت الكابشن لكن ملف الكابشن غير موجود.")
                if self.caption_font_path and self.caption_font_path.is_file():
                    font_dir = self.caption_font_path.parent
                caption_family = font_family(self.caption_font_path)
            if not self.overlays and captions is None:
                raise ValueError("أضف صورة/شريط أو فعّل الكابشن الأول.")
            ffmpeg = binary("ffmpeg.exe")
            ffprobe = binary("ffprobe.exe")
            destination = default_render_destination(source)
            overlays = [replace(overlay) for overlay in self.overlays]
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        def work():
            self._thread_status("إخراج الفيديو بالإضافات...", indeterminate=False)
            return render_video(
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                source=source,
                overlays=overlays,
                captions_ass=captions,
                font_dir=font_dir,
                caption_font_family=caption_family,
                destination=destination,
                progress_callback=self._thread_render_progress,
                log_callback=self._thread_log,
            )

        self._start_job("إخراج الفيديو...", work, self._render_finished)

    def _render_finished(self, result: Path) -> None:
        messagebox.showinfo(APP_TITLE, f"تم إخراج الفيديو.\n{result}")

    def _redraw_canvas(self) -> None:
        if not hasattr(self, "canvas"):
            return
        canvas = self.canvas
        cw = max(10, canvas.winfo_width())
        ch = max(10, canvas.winfo_height())
        canvas.delete("all")
        self.overlay_photos.clear()
        if self.preview_original is None:
            canvas.create_text(
                cw / 2,
                ch / 2,
                text="اختار فيديو ثم اختار توقيت اللقطة",
                fill="#cfcfcf",
                font=("Segoe UI", 13),
            )
            return

        iw, ih = self.preview_original.size
        scale = min(cw / iw, ch / ih)
        dw = max(1, round(iw * scale))
        dh = max(1, round(ih * scale))
        x0 = (cw - dw) / 2
        y0 = (ch - dh) / 2
        self.preview_rect = (x0, y0, dw, dh)
        resized = self.preview_original.resize((dw, dh), Image.Resampling.LANCZOS)
        self.preview_photo = ImageTk.PhotoImage(resized)
        canvas.create_image(x0, y0, anchor="nw", image=self.preview_photo)

        for index, overlay in enumerate(self.overlays):
            left = x0 + overlay.x * dw
            top = y0 + overlay.y * dh
            width = overlay.w * dw
            height = overlay.h * dh
            if overlay.kind == "bar":
                canvas.create_rectangle(
                    left,
                    top,
                    left + width,
                    top + height,
                    fill="#000000",
                    outline="",
                    tags=(f"overlay:{index}",),
                )
            else:
                image = self._overlay_image(overlay)
                if image:
                    display = image.resize(
                        (max(1, round(width)), max(1, round(height))),
                        Image.Resampling.LANCZOS,
                    )
                    photo = ImageTk.PhotoImage(display)
                    self.overlay_photos.append(photo)
                    canvas.create_image(
                        left,
                        top,
                        anchor="nw",
                        image=photo,
                        tags=(f"overlay:{index}",),
                    )
            if index == self.selected_overlay:
                canvas.create_rectangle(
                    left,
                    top,
                    left + width,
                    top + height,
                    outline="#00a3ff",
                    width=2,
                    tags=(f"overlay:{index}",),
                )
                self._draw_handles(index, left, top, left + width, top + height)

    def _overlay_image(self, overlay: Overlay) -> Image.Image | None:
        if overlay.path is None:
            return None
        cached = self.image_cache.get(overlay.path)
        if cached is not None:
            return cached
        try:
            with Image.open(overlay.path) as image:
                cached = image.convert("RGBA").copy()
        except Exception:
            return None
        self.image_cache[overlay.path] = cached
        return cached

    def _draw_handles(self, index: int, left: float, top: float, right: float, bottom: float) -> None:
        positions = {
            "nw": (left, top),
            "n": ((left + right) / 2, top),
            "ne": (right, top),
            "e": (right, (top + bottom) / 2),
            "se": (right, bottom),
            "s": ((left + right) / 2, bottom),
            "sw": (left, bottom),
            "w": (left, (top + bottom) / 2),
        }
        for direction, (x, y) in positions.items():
            half = HANDLE_SIZE / 2
            self.canvas.create_rectangle(
                x - half,
                y - half,
                x + half,
                y + half,
                fill="#ffffff",
                outline="#0079bf",
                tags=(f"handle:{index}:{direction}",),
            )

    def _canvas_press(self, event) -> None:
        if self.busy:
            return
        tags = self.canvas.gettags("current")
        overlay_index = None
        handle = None
        for tag in tags:
            if tag.startswith("handle:"):
                _, idx, direction = tag.split(":", 2)
                overlay_index = int(idx)
                handle = direction
                break
            if tag.startswith("overlay:"):
                overlay_index = int(tag.split(":", 1)[1])
        if overlay_index is None:
            self.selected_overlay = None
            self._sync_selected_overlay_ui()
            self._redraw_canvas()
            return
        self.selected_overlay = overlay_index
        self._sync_selected_overlay_ui()
        mode = handle or "move"
        self.drag_state = (
            mode,
            overlay_index,
            float(event.x),
            float(event.y),
            replace(self.overlays[overlay_index]),
        )
        self._redraw_canvas()

    def _canvas_drag(self, event) -> None:
        if self.busy or not self.drag_state:
            return
        mode, index, start_x, start_y, original = self.drag_state
        if index >= len(self.overlays):
            return
        x0, y0, dw, dh = self.preview_rect
        if dw <= 0 or dh <= 0:
            return
        dx_video = (float(event.x) - start_x) / dw * self.video_width
        dy_video = (float(event.y) - start_y) / dh * self.video_height
        if mode == "move":
            next_overlay = replace(
                original,
                x=self._clamp(original.x + dx_video / self.video_width, 0, 1 - original.w),
                y=self._clamp(original.y + dy_video / self.video_height, 0, 1 - original.h),
            )
        else:
            next_overlay = self._resize_overlay(original, mode, dx_video, dy_video)
        self.overlays[index] = next_overlay
        self._redraw_canvas()

    def _resize_overlay(self, overlay: Overlay, handle: str, dx: float, dy: float) -> Overlay:
        return resize_overlay(
            overlay,
            handle=handle,
            dx=dx,
            dy=dy,
            video_width=self.video_width,
            video_height=self.video_height,
        )

    def _start_job(self, label: str, target, on_success, *, indeterminate: bool = False) -> None:
        if self.busy:
            return
        self._set_busy(True)
        self._set_activity(label, indeterminate=indeterminate)

        def runner() -> None:
            try:
                result = target()
            except Exception as exc:
                error = str(exc)
                self._post_ui(self._job_failed, error)
            else:
                self._post_ui(self._job_succeeded, result, on_success)

        threading.Thread(target=runner, daemon=True).start()

    def _job_succeeded(self, result, on_success) -> None:
        self._set_busy(False)
        self._set_activity("تم ✓", percent=100)
        on_success(result)

    def _job_failed(self, error: str) -> None:
        self._set_busy(False)
        self._set_activity("حصل خطأ", percent=0)
        self._log(error)
        messagebox.showerror(APP_TITLE, error)

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        for button in self.action_buttons:
            button.configure(state=state)
        for widget, normal_state in self.busy_controls:
            try:
                widget.configure(state=state if busy else normal_state)
            except tk.TclError:
                pass

    def _set_activity(self, text: str, *, percent: float | None = None, indeterminate: bool = False) -> None:
        self.activity_var.set(text)
        if indeterminate:
            self.progress.configure(mode="indeterminate")
            self.progress.start(12)
        else:
            self.progress.stop()
            self.progress.configure(mode="determinate")
            if percent is not None:
                self.progress["value"] = max(0, min(100, percent))

    def _thread_status(self, text: str, *, indeterminate: bool = False) -> None:
        self._post_ui(self._set_activity_from_queue, text, indeterminate)
        self._thread_log(text)

    def _thread_download_progress(self, percent: float, speed: str, eta: str) -> None:
        text = f"تحميل {percent:.1f}%"
        if speed and speed != "Unknown B/s":
            text += f" — {speed}"
        if eta and eta != "Unknown":
            text += f" — باقي {eta}"
        self._post_ui(self._set_activity_percent, text, percent)

    def _thread_render_progress(self, percent: float) -> None:
        self._post_ui(self._set_activity_percent, f"إخراج الفيديو {percent:.1f}%", percent)

    def _thread_log(self, text: str) -> None:
        self._post_ui(self._log, text)

    def _set_activity_from_queue(self, text: str, indeterminate: bool) -> None:
        self._set_activity(text, indeterminate=indeterminate)

    def _set_activity_percent(self, text: str, percent: float) -> None:
        self._set_activity(text, percent=percent)

    def _post_ui(self, callback, *args) -> None:
        self.ui_queue.put((callback, args))

    def _drain_ui_queue(self) -> None:
        try:
            while True:
                callback, args = self.ui_queue.get_nowait()
                callback(*args)
        except queue.Empty:
            pass
        if self.winfo_exists():
            self.after(40, self._drain_ui_queue)

    def _log(self, text: str) -> None:
        clean = str(text).strip()
        if not clean:
            return
        self.log_text.configure(state="normal")
        self.log_text.insert("end", clean + "\n")
        line_count = int(self.log_text.index("end-1c").split(".")[0])
        if line_count > 80:
            self.log_text.delete("1.0", f"{line_count - 80}.0")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _on_close(self) -> None:
        if self.busy:
            messagebox.showwarning(APP_TITLE, "استنى العملية الحالية تخلص الأول.")
            return
        try:
            preview = self.temp_root / "preview.png"
            preview.unlink(missing_ok=True)
        except OSError:
            pass
        self.destroy()

    @staticmethod
    def _clamp(value: float, low: float, high: float) -> float:
        return max(low, min(high, float(value)))

    @staticmethod
    def _format_short_time(seconds: float) -> str:
        total = max(0, round(float(seconds)))
        hours, remainder = divmod(total, 3600)
        minutes, secs = divmod(remainder, 60)
        if hours:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        return f"{minutes:02d}:{secs:02d}"


if __name__ == "__main__":
    MiniVideoTool().mainloop()
