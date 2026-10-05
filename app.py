from __future__ import annotations

import shutil
import sys
import tempfile
import threading
import tkinter as tk
import queue
import time
from dataclasses import replace
from pathlib import Path
from tkinter import colorchooser, filedialog, messagebox, ttk

from PIL import Image, ImageFont, ImageTk

from core import QUALITY_FORMATS, cut_silence, download_section, parse_timecode
from media_edit import (
    CaptionStyle,
    Overlay,
    captions_for_section,
    default_render_destination,
    download_arabic_captions,
    extract_preview_frame,
    fast_render_destination,
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
        self.caption_style = CaptionStyle()
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
        self.operation_active = False
        self.operation_title = ""
        self.operation_started_at: float | None = None
        self.operation_eta_seconds: float | None = None
        self.operation_eta_label = "العملية"
        self.operation_output_dir: Path | None = None
        self.operation_output_bytes: float | None = None
        self.operation_size_label = "حجم الناتج"
        self.operation_requested_duration: float | None = None
        self.operation_last_disk_check = 0.0
        self.download_accumulated_bytes = 0.0
        self.download_transfer_peak = 0.0
        self.download_last_bytes = 0.0
        self.temp_root = Path(tempfile.gettempdir()) / "MiniVideoTool"
        self.temp_root.mkdir(parents=True, exist_ok=True)

        self.title(APP_TITLE)
        self.geometry("1180x900")
        self.minsize(1000, 760)
        self.configure(bg="#f4f4f4")
        self.option_add("*Font", ("Segoe UI", 10))
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(40, self._drain_ui_queue)
        self.after(500, self._tick_operation_clock)

    def _build(self) -> None:
        outer = ttk.Frame(self, padding=16)
        outer.pack(fill="both", expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(1, weight=1)

        header = ttk.Frame(outer)
        header.grid(row=0, column=0, sticky="ew")
        ttk.Label(header, text="Mini Video Tool", font=("Segoe UI Semibold", 19)).pack(anchor="e")
        ttk.Label(
            header,
            text="تحميل جزء • قص صمت • صور وكابشن — من غير زحمة.",
            foreground="#666666",
        ).pack(anchor="e", pady=(2, 10))

        self.tabs = ttk.Notebook(outer)
        self.tabs.grid(row=1, column=0, sticky="nsew")
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
        self.font_button.pack(fill="x", pady=(4, 4))
        self._busy_control(self.font_button)
        self.caption_style_button = ttk.Button(
            controls,
            text="ستايل الكابشن…",
            command=self._open_caption_style,
        )
        self.caption_style_button.pack(fill="x", pady=(0, 4))
        self._busy_control(self.caption_style_button)
        self.caption_style_summary_var = tk.StringVar(value=self._caption_style_summary())
        ttk.Label(
            controls,
            textvariable=self.caption_style_summary_var,
            foreground="#666666",
            wraplength=250,
            justify="right",
        ).pack(anchor="e", pady=(0, 12))
        self._busy_control(self.canvas)

        ttk.Separator(controls).pack(fill="x", pady=5)
        self.render_button = self._action_button(controls, "إخراج الفيديو", self._render_editor_video)
        self.render_button.pack(fill="x", ipady=6, pady=(10, 0))

    def _build_activity(self, parent: ttk.Frame) -> None:
        box = tk.Frame(parent, bg="#0b1220", padx=12, pady=10, bd=0)
        self.ops_box = box
        box.grid(row=2, column=0, sticky="ew", pady=(10, 0))

        header = tk.Frame(box, bg="#0b1220")
        header.pack(fill="x")
        self.activity_var = tk.StringVar(value="جاهز")
        self.activity_detail_var = tk.StringVar(value="لا توجد عملية نشطة")
        self.activity_percent_var = tk.StringVar(value="—")
        tk.Label(
            header,
            text="●",
            fg="#22c55e",
            bg="#0b1220",
            font=("Segoe UI", 12, "bold"),
        ).pack(side="right")
        title_box = tk.Frame(header, bg="#0b1220")
        title_box.pack(side="right", padx=(6, 0))
        tk.Label(
            title_box,
            textvariable=self.activity_var,
            fg="#f8fafc",
            bg="#0b1220",
            font=("Segoe UI Semibold", 11),
            anchor="e",
        ).pack(anchor="e")
        tk.Label(
            title_box,
            textvariable=self.activity_detail_var,
            fg="#94a3b8",
            bg="#0b1220",
            font=("Segoe UI", 9),
            anchor="e",
        ).pack(anchor="e")
        tk.Label(
            header,
            textvariable=self.activity_percent_var,
            fg="#86efac",
            bg="#0b1220",
            font=("Segoe UI Semibold", 17),
        ).pack(side="left")

        style = ttk.Style(self)
        style.configure(
            "Ops.Horizontal.TProgressbar",
            troughcolor="#1f2937",
            background="#22c55e",
            bordercolor="#1f2937",
            lightcolor="#22c55e",
            darkcolor="#22c55e",
            thickness=9,
        )
        self.progress = ttk.Progressbar(
            box,
            style="Ops.Horizontal.TProgressbar",
            mode="determinate",
            maximum=100,
            value=0,
        )
        self.progress.pack(fill="x", pady=(8, 8))

        metrics = tk.Frame(box, bg="#0b1220")
        metrics.pack(fill="x")
        for column in range(3):
            metrics.columnconfigure(column, weight=1, uniform="metric")
        self.telemetry_time_var, self.telemetry_time_detail_var = self._telemetry_card(
            metrics, 0, "الوقت", "00:00", "منقضي"
        )
        self.telemetry_transfer_var, self.telemetry_transfer_detail_var = self._telemetry_card(
            metrics, 1, "بيانات التحميل", "—", "لا يوجد نقل"
        )
        self.telemetry_output_var, self.telemetry_output_detail_var = self._telemetry_card(
            metrics, 2, "التخزين", "—", "المساحة الحرة —"
        )
        self.telemetry_segment_var, self.telemetry_segment_detail_var = self._telemetry_card(
            metrics, 3, "المقطع", "—", "لا يوجد مقطع"
        )
        self.telemetry_media_var, self.telemetry_media_detail_var = self._telemetry_card(
            metrics, 4, "الوسائط", "—", "لا توجد معلومات"
        )
        self.telemetry_engine_var, self.telemetry_engine_detail_var = self._telemetry_card(
            metrics, 5, "المحرك", "—", "في الانتظار"
        )

        footer = tk.Frame(box, bg="#0b1220")
        footer.pack(fill="x", pady=(8, 0))
        self.stage_rail_var = tk.StringVar(value="تهيئة  ›  تنفيذ  ›  معالجة  ›  جاهز")
        self.telemetry_file_var = tk.StringVar(value="الملف: —")
        self.log_visible = False
        self.log_toggle_button = tk.Button(
            footer,
            text="عرض السجل",
            command=self._toggle_log,
            bg="#1f2937",
            fg="#cbd5e1",
            activebackground="#334155",
            activeforeground="#f8fafc",
            relief="flat",
            bd=0,
            padx=8,
            pady=2,
            font=("Segoe UI", 8),
        )
        self.log_toggle_button.pack(side="left", padx=(0, 8))
        tk.Label(
            footer,
            textvariable=self.stage_rail_var,
            fg="#64748b",
            bg="#0b1220",
            font=("Segoe UI", 8),
        ).pack(side="left")
        tk.Label(
            footer,
            textvariable=self.telemetry_file_var,
            fg="#cbd5e1",
            bg="#0b1220",
            font=("Segoe UI", 8),
            anchor="e",
        ).pack(side="right")

        self.log_text = tk.Text(
            box,
            height=4,
            wrap="word",
            state="disabled",
            bg="#111827",
            fg="#cbd5e1",
            insertbackground="#cbd5e1",
            relief="flat",
            bd=0,
            font=("Cascadia Mono", 8),
        )

    def _toggle_log(self) -> None:
        self.log_visible = not self.log_visible
        if self.log_visible:
            self.log_text.pack(fill="x", pady=(6, 0))
            self.log_toggle_button.configure(text="إخفاء السجل")
        else:
            self.log_text.pack_forget()
            self.log_toggle_button.configure(text="عرض السجل")

    def _telemetry_card(
        self,
        parent: tk.Frame,
        column: int,
        title: str,
        initial: str,
        detail: str,
    ) -> tuple[tk.StringVar, tk.StringVar]:
        row, grid_column = divmod(column, 3)
        card = tk.Frame(parent, bg="#111827", padx=9, pady=5)
        card.grid(
            row=row,
            column=grid_column,
            sticky="nsew",
            padx=(0 if grid_column == 0 else 3, 0),
            pady=(0 if row == 0 else 3, 0),
        )
        main_var = tk.StringVar(value=initial)
        detail_var = tk.StringVar(value=detail)
        tk.Label(
            card,
            text=title,
            fg="#64748b",
            bg="#111827",
            font=("Segoe UI", 8),
            anchor="e",
        ).pack(fill="x")
        tk.Label(
            card,
            textvariable=main_var,
            fg="#f8fafc",
            bg="#111827",
            font=("Segoe UI Semibold", 10),
            anchor="e",
            wraplength=280,
            justify="right",
        ).pack(fill="x", pady=(1, 0))
        tk.Label(
            card,
            textvariable=detail_var,
            fg="#94a3b8",
            bg="#111827",
            font=("Segoe UI", 7),
            anchor="e",
            wraplength=280,
            justify="right",
        ).pack(fill="x")
        return main_var, detail_var

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

        self._begin_operation(
            title="تحميل جزء من يوتيوب",
            detail=f"{quality} • {self._format_short_time(start)} ← {self._format_short_time(end)}",
            output_dir=output,
            segment=(start, end),
            media_label=quality,
            engine_label="yt-dlp",
            stage_rail="تهيئة  ›  تحميل  ›  تسوية  ›  كابشن  ›  جاهز",
        )

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
                telemetry_callback=self._thread_download_telemetry,
                log_callback=self._thread_log,
            )
            self._thread_status("فحص الملف النهائي...", indeterminate=True)
            info = probe_media(ffprobe, video)
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
            return video, caption_file, info

        self._start_job("جاري التحميل...", work, self._download_finished, indeterminate=True)

    def _download_finished(self, result) -> None:
        video, caption_file, info = result
        self._apply_media_info(info, video)
        self.editor_source_var.set(str(video))
        if caption_file:
            self.caption_file_var.set(str(caption_file))
            self.captions_enabled_var.set(True)
        else:
            self.caption_file_var.set("")
            self.captions_enabled_var.set(False)
        self._load_editor_source(video, extract_now=False, prefetched_info=info)
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

        self._begin_operation(
            title="قص الصمت",
            detail=source.name,
            output_dir=source.parent,
            media_label=source.suffix.lstrip(".").upper() or "فيديو",
            engine_label="FFmpeg",
            stage_rail="فحص  ›  تحليل الصمت  ›  خطة القص  ›  إعادة بناء  ›  جاهز",
            source=source,
        )

        def work():
            self._thread_status("تحليل الصمت...", indeterminate=True)
            return cut_silence(
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                source=source,
                status_callback=lambda text: self._thread_status(text, indeterminate=True),
                telemetry_callback=self._thread_ffmpeg_telemetry,
                log_callback=self._thread_log,
            )

        self._start_job("تحليل الصمت...", work, self._silence_finished, indeterminate=True)

    def _silence_finished(self, result: Path) -> None:
        self.operation_output_bytes = float(result.stat().st_size)
        self.operation_size_label = "حجم الناتج"
        self.telemetry_output_var.set(self._format_bytes(self.operation_output_bytes))
        self.telemetry_file_var.set(f"الملف: {self._short_text(result.name)}")
        self._update_disk_metric(force=True)
        messagebox.showinfo(APP_TITLE, f"تم قص الصمت.\n{result}")

    def _load_editor_source(
        self,
        source: Path,
        *,
        extract_now: bool = True,
        prefetched_info: dict | None = None,
    ) -> None:
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
        if prefetched_info is not None:
            width, height, duration = video_geometry(prefetched_info)
            self._editor_source_loaded((source, generation, width, height, duration, extract_now))
            return
        try:
            ffprobe = binary("ffprobe.exe")
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return
        self._begin_operation(
            title="قراءة معلومات الفيديو",
            detail=source.name,
            output_dir=source.parent,
            media_label=source.suffix.lstrip(".").upper() or "فيديو",
            engine_label="ffprobe",
            stage_rail="فتح الملف  ›  قراءة المسارات  ›  تجهيز المعاينة  ›  جاهز",
            source=source,
        )

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
        self.telemetry_media_var.set(f"{width}×{height}")
        self.telemetry_media_detail_var.set(f"مدة {self._format_duration(duration)}")
        if source.is_file():
            self.operation_output_bytes = float(source.stat().st_size)
            self.operation_size_label = "حجم المصدر"
            self.telemetry_output_var.set(self._format_bytes(self.operation_output_bytes))
            self.telemetry_file_var.set(f"الملف: {self._short_text(source.name)}")
            self._update_disk_metric(force=True)
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

        self._begin_operation(
            title="استخراج لقطة المعاينة",
            detail=f"{source.name} • عند {self._format_short_time(timestamp)}",
            output_dir=source.parent,
            media_label=f"{self.video_width}×{self.video_height}" if self.video_width else source.suffix.upper(),
            engine_label="FFmpeg",
            stage_rail="فتح الفيديو  ›  الوصول للتوقيت  ›  استخراج لقطة  ›  جاهز",
            source=source,
        )

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
            self.caption_style_summary_var.set(self._caption_style_summary())

    def _caption_style_summary(self) -> str:
        style = self.caption_style
        position = {"top": "فوق", "middle": "وسط", "bottom": "تحت"}.get(
            style.position, "تحت"
        )
        background = (
            f"خلفية {style.background_opacity:.0f}%" if style.background_enabled else "بدون خلفية"
        )
        return (
            f"{style.size_percent:.1f}% • شادو {style.shadow:.1f} • "
            f"{background} • {position}"
        )

    def _open_caption_style(self) -> None:
        if self.busy:
            return
        style = self.caption_style
        original_font_path = self.caption_font_path
        selected_font_path = self.caption_font_path
        win = tk.Toplevel(self)
        win.title("ستايل الكابشن")
        win.transient(self)
        win.resizable(False, False)
        win.grab_set()

        frame = ttk.Frame(win, padding=16)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(1, weight=1)

        size_var = tk.DoubleVar(value=style.size_percent)
        outline_var = tk.DoubleVar(value=style.outline_width)
        shadow_var = tk.DoubleVar(value=style.shadow)
        background_enabled_var = tk.BooleanVar(value=style.background_enabled)
        background_opacity_var = tk.DoubleVar(value=style.background_opacity)
        margin_var = tk.DoubleVar(value=style.margin_percent)
        bold_var = tk.BooleanVar(value=style.bold)
        italic_var = tk.BooleanVar(value=style.italic)
        position_var = tk.StringVar(
            value={"bottom": "أسفل", "middle": "منتصف", "top": "أعلى"}.get(
                style.position, "أسفل"
            )
        )
        horizontal_var = tk.StringVar(
            value={"left": "يسار", "center": "وسط", "right": "يمين"}.get(
                style.horizontal, "وسط"
            )
        )
        colors = {
            "text": style.text_color,
            "outline": style.outline_color,
            "shadow": style.shadow_color,
            "background": style.background_color,
        }
        color_buttons: dict[str, tk.Button] = {}

        row = 0
        ttk.Label(frame, text="الخط").grid(row=row, column=0, sticky="e", padx=(0, 10), pady=4)
        font_label = ttk.Label(frame, text=self._font_display_text(), width=34, anchor="e")
        font_label.grid(row=row, column=1, sticky="ew", pady=4)

        def choose_font_here() -> None:
            nonlocal selected_font_path
            selected = filedialog.askopenfilename(
                parent=win,
                filetypes=[("Fonts", "*.otf *.ttf"), ("All files", "*.*")],
            )
            if selected:
                selected_font_path = Path(selected).resolve()
                try:
                    family = font_family(selected_font_path)
                except Exception:
                    family = "Arial"
                font_label.configure(text=f"خط الكابشن: {family}")

        ttk.Button(frame, text="اختيار…", command=choose_font_here).grid(
            row=row, column=2, sticky="ew", pady=4
        )

        row += 1
        ttk.Label(frame, text="الحجم").grid(row=row, column=0, sticky="e", padx=(0, 10), pady=4)
        ttk.Scale(frame, from_=1.5, to=10.0, variable=size_var, orient="horizontal").grid(
            row=row, column=1, sticky="ew", pady=4
        )
        ttk.Label(frame, text="% من ارتفاع الفيديو").grid(row=row, column=2, sticky="w", pady=4)

        def color_row(label: str, key: str) -> None:
            nonlocal row
            row += 1
            ttk.Label(frame, text=label).grid(row=row, column=0, sticky="e", padx=(0, 10), pady=4)

            def pick() -> None:
                chosen = colorchooser.askcolor(colors[key], parent=win)[1]
                if chosen:
                    colors[key] = chosen.upper()
                    color_buttons[key].configure(bg=colors[key], activebackground=colors[key])

            button = tk.Button(
                frame,
                text=colors[key],
                bg=colors[key],
                fg="#000000" if key == "text" else "#ffffff",
                relief="flat",
                command=pick,
                width=16,
            )
            color_buttons[key] = button
            button.grid(row=row, column=1, sticky="ew", pady=4)

        color_row("لون النص", "text")
        color_row("لون الحد", "outline")

        row += 1
        ttk.Label(frame, text="سمك الحد").grid(row=row, column=0, sticky="e", padx=(0, 10), pady=4)
        ttk.Scale(frame, from_=0, to=6, variable=outline_var, orient="horizontal").grid(
            row=row, column=1, sticky="ew", pady=4
        )

        color_row("لون الشادو", "shadow")
        row += 1
        ttk.Label(frame, text="قوة الشادو").grid(row=row, column=0, sticky="e", padx=(0, 10), pady=4)
        ttk.Scale(frame, from_=0, to=6, variable=shadow_var, orient="horizontal").grid(
            row=row, column=1, sticky="ew", pady=4
        )

        row += 1
        ttk.Checkbutton(
            frame,
            text="خلفية خلف النص",
            variable=background_enabled_var,
        ).grid(row=row, column=1, sticky="e", pady=4)
        color_row("لون الخلفية", "background")

        row += 1
        ttk.Label(frame, text="شفافية الخلفية").grid(
            row=row, column=0, sticky="e", padx=(0, 10), pady=4
        )
        ttk.Scale(frame, from_=0, to=100, variable=background_opacity_var, orient="horizontal").grid(
            row=row, column=1, sticky="ew", pady=4
        )
        ttk.Label(frame, text="0% مخفية • 100% مصمتة").grid(row=row, column=2, sticky="w", pady=4)

        row += 1
        ttk.Label(frame, text="الموضع الرأسي").grid(row=row, column=0, sticky="e", padx=(0, 10), pady=4)
        ttk.Combobox(
            frame,
            textvariable=position_var,
            values=("أعلى", "منتصف", "أسفل"),
            state="readonly",
            width=16,
        ).grid(row=row, column=1, sticky="ew", pady=4)

        row += 1
        ttk.Label(frame, text="المحاذاة").grid(row=row, column=0, sticky="e", padx=(0, 10), pady=4)
        ttk.Combobox(
            frame,
            textvariable=horizontal_var,
            values=("يمين", "وسط", "يسار"),
            state="readonly",
            width=16,
        ).grid(row=row, column=1, sticky="ew", pady=4)

        row += 1
        ttk.Label(frame, text="الهامش من الحافة").grid(
            row=row, column=0, sticky="e", padx=(0, 10), pady=4
        )
        ttk.Scale(frame, from_=0, to=25, variable=margin_var, orient="horizontal").grid(
            row=row, column=1, sticky="ew", pady=4
        )
        ttk.Label(frame, text="% من ارتفاع الفيديو").grid(row=row, column=2, sticky="w", pady=4)

        row += 1
        flags = ttk.Frame(frame)
        flags.grid(row=row, column=1, sticky="e", pady=(6, 10))
        ttk.Checkbutton(flags, text="عريض", variable=bold_var).pack(side="right", padx=5)
        ttk.Checkbutton(flags, text="مائل", variable=italic_var).pack(side="right", padx=5)

        row += 1
        buttons = ttk.Frame(frame)
        buttons.grid(row=row, column=0, columnspan=3, sticky="ew", pady=(8, 0))

        def apply_style() -> None:
            self.caption_font_path = selected_font_path
            self.font_label_var.set(self._font_display_text())
            self.caption_style = CaptionStyle(
                size_percent=float(size_var.get()),
                text_color=colors["text"],
                outline_color=colors["outline"],
                outline_width=float(outline_var.get()),
                shadow=float(shadow_var.get()),
                shadow_color=colors["shadow"],
                background_enabled=bool(background_enabled_var.get()),
                background_color=colors["background"],
                background_opacity=float(background_opacity_var.get()),
                position={"أسفل": "bottom", "منتصف": "middle", "أعلى": "top"}[
                    position_var.get()
                ],
                horizontal={"يسار": "left", "وسط": "center", "يمين": "right"}[
                    horizontal_var.get()
                ],
                margin_percent=float(margin_var.get()),
                bold=bool(bold_var.get()),
                italic=bool(italic_var.get()),
            )
            self.caption_style_summary_var.set(self._caption_style_summary())
            win.destroy()

        def cancel_style() -> None:
            self.caption_font_path = original_font_path
            win.destroy()

        ttk.Button(buttons, text="تطبيق", command=apply_style).pack(side="right")
        ttk.Button(buttons, text="إلغاء", command=cancel_style).pack(side="right", padx=6)
        win.protocol("WM_DELETE_WINDOW", cancel_style)

        win.update_idletasks()
        x = self.winfo_rootx() + max(20, (self.winfo_width() - win.winfo_reqwidth()) // 2)
        y = self.winfo_rooty() + max(20, (self.winfo_height() - win.winfo_reqheight()) // 2)
        win.geometry(f"+{x}+{y}")

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
            destination = fast_render_destination(source)
            overlays = [replace(overlay) for overlay in self.overlays]
            caption_style = replace(self.caption_style)
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        self._begin_operation(
            title="إخراج الفيديو",
            detail=f"{source.name} • {len(overlays)} عنصر",
            output_dir=destination.parent,
            segment=(0.0, self.video_duration) if self.video_duration > 0 else None,
            media_label=f"{self.video_width}×{self.video_height}" if self.video_width else source.suffix.upper(),
            engine_label="FFmpeg",
            stage_rail="فحص  ›  تركيب العناصر  ›  ترميز  ›  إنهاء  ›  جاهز",
            source=source,
        )

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
                caption_style=caption_style,
                destination=destination,
                prefer_hardware=True,
                telemetry_callback=self._thread_ffmpeg_telemetry,
                log_callback=self._thread_log,
            )

        self._start_job("إخراج الفيديو...", work, self._render_finished)

    def _render_finished(self, result: Path) -> None:
        self.operation_output_bytes = float(result.stat().st_size)
        self.operation_size_label = "حجم الناتج"
        self.telemetry_output_var.set(self._format_bytes(self.operation_output_bytes))
        self.telemetry_file_var.set(f"الملف: {self._short_text(result.name)}")
        self._update_disk_metric(force=True)
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

    def _begin_operation(
        self,
        *,
        title: str,
        detail: str,
        output_dir: Path | None = None,
        segment: tuple[float, float] | None = None,
        media_label: str = "—",
        engine_label: str = "—",
        stage_rail: str = "تهيئة  ›  تنفيذ  ›  معالجة  ›  جاهز",
        source: Path | None = None,
    ) -> None:
        self.operation_active = True
        self.operation_title = title
        self.operation_started_at = time.monotonic()
        self.operation_eta_seconds = None
        self.operation_eta_label = "العملية"
        self.operation_output_dir = Path(output_dir).expanduser() if output_dir else None
        self.operation_output_bytes = None
        self.operation_size_label = "حجم الناتج"
        self.operation_requested_duration = None
        self.operation_last_disk_check = 0.0
        self.download_accumulated_bytes = 0.0
        self.download_transfer_peak = 0.0
        self.download_last_bytes = 0.0
        self.activity_detail_var.set(detail)
        self.stage_rail_var.set(stage_rail)
        self.telemetry_time_var.set("00:00")
        self.telemetry_time_detail_var.set("منقضي")
        self.telemetry_transfer_var.set("—")
        self.telemetry_transfer_detail_var.set("لا يوجد نقل")
        self.telemetry_output_var.set("—")
        self.telemetry_output_detail_var.set("المساحة الحرة —")
        self.telemetry_media_var.set(media_label or "—")
        self.telemetry_media_detail_var.set("في انتظار معلومات الملف")
        self.telemetry_engine_var.set(engine_label or "—")
        self.telemetry_engine_detail_var.set("تهيئة")
        self.telemetry_file_var.set(
            f"الملف: {self._short_text(source.name)}" if source else "الملف: —"
        )
        if segment:
            start, end = segment
            self.operation_requested_duration = max(0.0, end - start)
            self.telemetry_segment_var.set(
                f"{self._format_short_time(start)} ← {self._format_short_time(end)}"
            )
            self.telemetry_segment_detail_var.set(
                f"المدة المطلوبة {self._format_duration(self.operation_requested_duration)}"
            )
        else:
            self.telemetry_segment_var.set("—")
            self.telemetry_segment_detail_var.set("لا يوجد مقطع")
        self._set_activity(title, percent=0)
        self._update_disk_metric(force=True)
        self._log(f"بدأت العملية: {title}")

    def _thread_download_telemetry(self, telemetry: dict) -> None:
        self._post_ui(self._apply_download_telemetry, telemetry)

    def _apply_download_telemetry(self, telemetry: dict) -> None:
        stage = str(telemetry.get("stage") or "download")
        stage_names = {
            "download": "تنزيل بيانات الوسائط من يوتيوب",
            "download_stream": "تحميل HLS السريع لحظيًا",
            "download_normalize": "تسوية بداية الصوت والصورة بدون إعادة ترميز",
            "download_normalized": "تمت تسوية المسارات",
            "download_ready": "الملف النهائي جاهز",
        }
        percent = float(telemetry.get("percent") or 0.0)
        self.activity_detail_var.set(stage_names.get(stage, "تنزيل بيانات الوسائط"))
        self._set_activity(self.operation_title or "تحميل", percent=percent)

        output_size = telemetry.get("output_size")
        if isinstance(output_size, (int, float)) and output_size >= 0:
            self.operation_output_bytes = float(output_size)
            self.operation_size_label = "حجم الناتج"
            self.telemetry_output_var.set(self._format_bytes(self.operation_output_bytes))
            self._update_disk_metric(force=True)
        if stage.startswith("download_normal"):
            trim = telemetry.get("trim_seconds")
            self.telemetry_engine_var.set("FFmpeg • نسخ مباشر")
            self.telemetry_engine_detail_var.set(
                f"تسوية {float(trim):.2f} ث بدون إعادة ترميز"
                if isinstance(trim, (int, float))
                else "تسوية المسارات بدون إعادة ترميز"
            )
            return
        if stage == "download_ready":
            self.telemetry_engine_var.set("جاهز")
            self.telemetry_engine_detail_var.set("انتهى تنزيل وتجهيز الملف")
            return
        self.activity_percent_var.set(f"النقل {percent:.1f}%")

        downloaded = telemetry.get("downloaded_bytes")
        if isinstance(downloaded, (int, float)) and downloaded >= 0:
            downloaded = float(downloaded)
            if self.download_last_bytes > 0 and downloaded < self.download_last_bytes * 0.5:
                self.download_accumulated_bytes += self.download_transfer_peak
                self.download_transfer_peak = 0.0
            self.download_transfer_peak = max(self.download_transfer_peak, downloaded)
            self.download_last_bytes = downloaded
            received = self.download_accumulated_bytes + downloaded
            self.telemetry_transfer_var.set(self._format_bytes(received))

            exact_total = telemetry.get("total_bytes")
            estimated_total = telemetry.get("total_bytes_estimate")
            total = exact_total if isinstance(exact_total, (int, float)) else estimated_total
            prefix = "" if isinstance(exact_total, (int, float)) else "~"
            speed = telemetry.get("speed")
            speed_text = (
                f"{self._format_bytes(float(speed))}/ث"
                if isinstance(speed, (int, float)) and speed > 0
                else str(telemetry.get("speed_text") or "—").strip()
            )
            if isinstance(total, (int, float)) and total > 0:
                self.telemetry_transfer_detail_var.set(
                    f"{speed_text} • النقل الحالي {self._format_bytes(downloaded)} / {prefix}{self._format_bytes(float(total))}"
                )
            else:
                self.telemetry_transfer_detail_var.set(f"{speed_text} • وسائط مستلمة فعليًا")

        eta_value = telemetry.get("eta_seconds")
        eta = (
            float(eta_value)
            if isinstance(eta_value, (int, float))
            else self._parse_eta_text(str(telemetry.get("eta_text") or ""))
        )
        self.operation_eta_seconds = eta
        self.operation_eta_label = "النقل الحالي"
        speed_text = str(telemetry.get("speed_text") or "").strip()
        self.telemetry_engine_var.set("HLS • FFmpeg" if stage == "download_stream" else "yt-dlp")
        self.telemetry_engine_detail_var.set(
            f"سرعة {speed_text}" if speed_text and "Unknown" not in speed_text else "نقل مباشر من يوتيوب"
        )

    def _thread_ffmpeg_telemetry(self, telemetry: dict) -> None:
        self._post_ui(self._apply_ffmpeg_telemetry, telemetry)

    def _apply_ffmpeg_telemetry(self, telemetry: dict) -> None:
        stage = str(telemetry.get("stage") or "")
        stage_names = {
            "silence_probe": "فحص الفيديو والصوت",
            "silence_analyze": "تحليل الصمت لحظيًا",
            "silence_plan": "حساب خطة القص",
            "silence_render": "إعادة بناء الفيديو بدون الصمت",
            "silence_done": "تم قص الصمت",
            "render_prepare": "تجهيز مسار الإخراج السريع",
            "render": "تركيب العناصر وترميز الفيديو",
            "render_done": "تم إخراج الفيديو",
        }
        if stage in stage_names:
            self.activity_detail_var.set(stage_names[stage])

        percent = telemetry.get("percent")
        if isinstance(percent, (int, float)):
            self._set_activity(self.operation_title or "معالجة", percent=float(percent))

        encoder_label = str(telemetry.get("encoder") or "").strip()
        if stage == "render_prepare" and encoder_label:
            self.telemetry_engine_var.set(encoder_label)
            self.telemetry_engine_detail_var.set("اختيار محرك الترميز تلقائيًا")

        eta = telemetry.get("eta_seconds")
        self.operation_eta_seconds = float(eta) if isinstance(eta, (int, float)) else None
        self.operation_eta_label = "المعالجة"

        if stage == "silence_probe":
            duration = float(telemetry.get("duration") or 0.0)
            width = int(telemetry.get("width") or 0)
            height = int(telemetry.get("height") or 0)
            container = str(telemetry.get("container") or "").upper()
            vcodec = str(telemetry.get("video_codec") or "—")
            acodec = str(telemetry.get("audio_codec") or "—")
            self.telemetry_media_var.set(
                f"{width}×{height} • {container}" if width and height else (container or "فيديو")
            )
            self.telemetry_media_detail_var.set(
                f"{vcodec} + {acodec} • {self._format_duration(duration)}"
            )
            source_size = telemetry.get("source_size")
            if isinstance(source_size, (int, float)):
                self.telemetry_output_var.set(self._format_bytes(float(source_size)))
                self.operation_size_label = "حجم المصدر"

        if stage == "silence_plan":
            removed = float(telemetry.get("silence_seconds") or 0.0)
            kept = float(telemetry.get("kept_duration") or 0.0)
            intervals = int(telemetry.get("interval_count") or 0)
            self.telemetry_segment_var.set(f"حذف {self._format_duration(removed)}")
            self.telemetry_segment_detail_var.set(
                f"متبقي {self._format_duration(kept)} • {intervals} منطقة صمت"
            )

        out_time = telemetry.get("out_time")
        duration = telemetry.get("duration")
        if isinstance(out_time, (int, float)) and isinstance(duration, (int, float)) and duration > 0:
            self.telemetry_segment_var.set(
                f"{self._format_duration(float(out_time))} / {self._format_duration(float(duration))}"
            )
            self.telemetry_segment_detail_var.set("زمن الوسائط المعالج")

        total_size = telemetry.get("total_size")
        output_size = telemetry.get("output_size")
        current_size = output_size if isinstance(output_size, (int, float)) else total_size
        if isinstance(current_size, (int, float)) and current_size >= 0:
            self.operation_output_bytes = float(current_size)
            self.operation_size_label = "حجم الناتج"
            self.telemetry_output_var.set(self._format_bytes(self.operation_output_bytes))

        speed_text = str(telemetry.get("speed_text") or "").strip()
        speed_factor = telemetry.get("speed_factor")
        fps = telemetry.get("fps")
        bitrate = str(telemetry.get("bitrate") or "").strip()
        display_speed = (
            f"×{float(speed_factor):.2f}"
            if isinstance(speed_factor, (int, float)) and speed_factor > 0
            else speed_text.replace("x", "×")
        )
        engine_main = display_speed if display_speed else (encoder_label or "FFmpeg")
        if isinstance(fps, (int, float)) and fps > 0:
            engine_main = f"{encoder_label or display_speed or 'FFmpeg'} • {display_speed or '—'} • {float(fps):.1f} إطار/ث"
        self.telemetry_engine_var.set(engine_main)
        bitrate_display = bitrate.replace("kbits/s", "كبت/ث").replace("Mbits/s", "مبت/ث")
        self.telemetry_engine_detail_var.set(
            f"معدل البت {bitrate_display}" if bitrate_display and bitrate_display != "N/A" else "معالجة محلية"
        )
        self._update_disk_metric()

    def _apply_media_info(self, info: dict, path: Path) -> None:
        streams = info.get("streams") or []
        video = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
        audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), {})
        format_info = info.get("format") or {}
        width = int(video.get("width") or 0)
        height = int(video.get("height") or 0)
        duration = float(format_info.get("duration") or 0.0)
        container = str(format_info.get("format_name") or path.suffix.lstrip(".")).split(",", 1)[0].upper()
        vcodec = str(video.get("codec_name") or "—").upper()
        acodec = str(audio.get("codec_name") or "—").upper()
        self.telemetry_media_var.set(
            f"{width}×{height} • {container}" if width and height else container
        )
        self.telemetry_media_detail_var.set(
            f"{vcodec} + {acodec} • {self._format_duration(duration)}"
        )
        if self.operation_requested_duration is not None:
            self.telemetry_segment_detail_var.set(
                f"مطلوب {self._format_duration(self.operation_requested_duration)} • فعلي {self._format_duration(duration)}"
            )
        if path.is_file():
            self.operation_output_bytes = float(path.stat().st_size)
            self.operation_size_label = "حجم الناتج"
            self.telemetry_output_var.set(self._format_bytes(self.operation_output_bytes))
            self.telemetry_file_var.set(f"الملف: {self._short_text(path.name)}")
        self._update_disk_metric(force=True)

    def _tick_operation_clock(self) -> None:
        if getattr(self, "operation_active", False) and self.operation_started_at is not None:
            elapsed = max(0.0, time.monotonic() - self.operation_started_at)
            self.telemetry_time_var.set(self._format_duration(elapsed))
            if self.operation_eta_seconds is not None:
                self.telemetry_time_detail_var.set(
                    f"منقضي • باقي {self.operation_eta_label} {self._format_duration(self.operation_eta_seconds)}"
                )
            else:
                self.telemetry_time_detail_var.set("منقضي • المتبقي غير معروف بعد")
            self._update_disk_metric()
        if self.winfo_exists():
            self.after(500, self._tick_operation_clock)

    def _update_disk_metric(self, *, force: bool = False) -> None:
        if self.operation_output_dir is None:
            return
        now = time.monotonic()
        if not force and now - self.operation_last_disk_check < 1.0:
            return
        self.operation_last_disk_check = now
        probe = self.operation_output_dir
        try:
            while not probe.exists() and probe.parent != probe:
                probe = probe.parent
            free = shutil.disk_usage(probe).free
        except OSError:
            return
        if self.operation_output_bytes is not None:
            self.telemetry_output_var.set(self._format_bytes(self.operation_output_bytes))
            self.telemetry_output_detail_var.set(
                f"{self.operation_size_label} • حر {self._format_bytes(float(free))}"
            )
        else:
            self.telemetry_output_detail_var.set(f"حر {self._format_bytes(float(free))}")

    def _start_job(self, label: str, target, on_success, *, indeterminate: bool = False) -> None:
        if self.busy:
            return
        if not self.operation_active:
            self._begin_operation(
                title=label,
                detail=label,
                engine_label="FFmpeg" if "لقطة" in label or "فيديو" in label else "—",
            )
        self._set_busy(True)
        self.activity_detail_var.set(label)
        self._set_activity(self.operation_title or label, indeterminate=indeterminate)

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
        elapsed = None
        if self.operation_started_at is not None:
            elapsed = max(0.0, time.monotonic() - self.operation_started_at)
        self.operation_active = False
        self._set_busy(False)
        self._set_activity("تم ✓", percent=100)
        self.activity_detail_var.set(self.operation_title or "اكتملت العملية")
        self.operation_eta_seconds = 0.0
        if elapsed is not None:
            self.telemetry_time_var.set(self._format_duration(elapsed))
            self.telemetry_time_detail_var.set("إجمالي زمن العملية")
        try:
            on_success(result)
        except Exception as exc:
            self._job_failed(str(exc))

    def _job_failed(self, error: str) -> None:
        self.operation_active = False
        self._set_busy(False)
        self._set_activity("حصل خطأ", percent=0)
        self.activity_detail_var.set(self.operation_title or "فشلت العملية")
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
            self.activity_percent_var.set("…")
        else:
            self.progress.stop()
            self.progress.configure(mode="determinate")
            if percent is not None:
                value = max(0, min(100, percent))
                self.progress["value"] = value
                self.activity_percent_var.set(f"{value:.1f}%")

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
        self.activity_detail_var.set(text)
        self._set_activity(self.operation_title or text, indeterminate=indeterminate)

    def _set_activity_percent(self, text: str, percent: float) -> None:
        self._set_activity(text, percent=percent)

    def _post_ui(self, callback, *args) -> None:
        self.ui_queue.put((callback, args))

    def _drain_ui_queue(self) -> None:
        try:
            while True:
                callback, args = self.ui_queue.get_nowait()
                try:
                    callback(*args)
                except Exception as exc:
                    try:
                        self._log(f"خطأ في تحديث الواجهة: {exc}")
                    except Exception:
                        pass
        except queue.Empty:
            pass
        finally:
            if self.winfo_exists():
                self.after(40, self._drain_ui_queue)

    def _log(self, text: str) -> None:
        clean = str(text).strip()
        if not clean:
            return
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{time.strftime('%H:%M:%S')}] {clean}\n")
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

    @staticmethod
    def _format_duration(seconds: float) -> str:
        total = max(0, round(float(seconds)))
        hours, remainder = divmod(total, 3600)
        minutes, secs = divmod(remainder, 60)
        if hours:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        return f"{minutes:02d}:{secs:02d}"

    @staticmethod
    def _format_bytes(value: float) -> str:
        number = max(0.0, float(value))
        units = ("بايت", "ك.ب", "م.ب", "ج.ب", "ت.ب")
        index = 0
        while number >= 1024 and index < len(units) - 1:
            number /= 1024.0
            index += 1
        if index == 0:
            return f"{number:.0f} {units[index]}"
        if number >= 100:
            return f"{number:.0f} {units[index]}"
        if number >= 10:
            return f"{number:.1f} {units[index]}"
        return f"{number:.2f} {units[index]}"

    @staticmethod
    def _parse_eta_text(value: str) -> float | None:
        text = str(value).strip()
        if not text or "Unknown" in text or text in {"NA", "N/A", "--"}:
            return None
        try:
            parts = [int(part) for part in text.split(":")]
        except ValueError:
            return None
        if len(parts) == 3:
            return float(parts[0] * 3600 + parts[1] * 60 + parts[2])
        if len(parts) == 2:
            return float(parts[0] * 60 + parts[1])
        if len(parts) == 1:
            return float(parts[0])
        return None

    @staticmethod
    def _short_text(value: str, max_chars: int = 64) -> str:
        text = str(value)
        if len(text) <= max_chars:
            return text
        keep = max(8, (max_chars - 1) // 2)
        return f"{text[:keep]}…{text[-keep:]}"


if __name__ == "__main__":
    MiniVideoTool().mainloop()
