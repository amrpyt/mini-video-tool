from __future__ import annotations

import shutil
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from core import QUALITY_FORMATS, cut_silence, download_section, parse_timecode


APP_TITLE = "Mini Video Tool"


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


class MiniVideoTool(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.busy = False
        self.title(APP_TITLE)
        self.geometry("680x520")
        self.minsize(620, 480)
        self.configure(bg="#f5f5f5")
        self.option_add("*Font", ("Segoe UI", 10))
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build(self) -> None:
        outer = ttk.Frame(self, padding=18)
        outer.pack(fill="both", expand=True)

        title = ttk.Label(outer, text="Mini Video Tool", font=("Segoe UI Semibold", 18))
        title.pack(anchor="e")
        subtitle = ttk.Label(
            outer,
            text="تحميل جزء من يوتيوب + قص الصمت. بس.",
            foreground="#666666",
        )
        subtitle.pack(anchor="e", pady=(2, 14))

        tabs = ttk.Notebook(outer)
        tabs.pack(fill="both", expand=True)

        download_tab = ttk.Frame(tabs, padding=18)
        silence_tab = ttk.Frame(tabs, padding=18)
        tabs.add(download_tab, text="تحميل جزء من يوتيوب")
        tabs.add(silence_tab, text="قص الصمت")

        self._build_download(download_tab)
        self._build_silence(silence_tab)

    def _build_download(self, parent: ttk.Frame) -> None:
        self.url_var = tk.StringVar()
        self.start_var = tk.StringVar(value="00:00:00")
        self.end_var = tk.StringVar(value="00:01:00")
        self.quality_var = tk.StringVar(value="أفضل جودة متاحة")
        self.output_var = tk.StringVar(value=str(Path.home() / "Downloads"))
        self.download_status = tk.StringVar(value="جاهز")

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
            text="أفضل جودة = أعلى جودة متاحة من يوتيوب، وليست ملف الفيديو الأصلي قبل الرفع.",
            foreground="#777777",
        ).pack(anchor="e", pady=(0, 12))
        ttk.Label(
            parent,
            text="البداية والنهاية تقريبية حسب keyframes للحفاظ على السرعة والجودة بدون إعادة ترميز.",
            foreground="#777777",
        ).pack(anchor="e", pady=(0, 12))

        self._label(parent, "مكان الحفظ").pack(fill="x")
        output_row = ttk.Frame(parent)
        output_row.pack(fill="x", pady=(4, 16))
        ttk.Button(output_row, text="اختيار", command=self._choose_output).pack(side="left")
        ttk.Entry(output_row, textvariable=self.output_var, justify="right").pack(
            side="right", fill="x", expand=True, padx=(8, 0)
        )

        self.download_button = ttk.Button(
            parent,
            text="تحميل الجزء",
            command=self._download,
        )
        self.download_button.pack(fill="x", ipady=7)
        ttk.Label(parent, textvariable=self.download_status, foreground="#555555").pack(
            anchor="e", pady=(10, 0)
        )

    def _build_silence(self, parent: ttk.Frame) -> None:
        self.silence_source_var = tk.StringVar()
        self.silence_status = tk.StringVar(value="جاهز")

        ttk.Label(
            parent,
            text="اختار فيديو. الأداة تشيل فترات الصمت وتسيب هامش صغير طبيعي حوالين الكلام.",
            wraplength=580,
            justify="right",
        ).pack(anchor="e", pady=(0, 14))
        self._label(parent, "الفيديو").pack(fill="x")
        file_row = ttk.Frame(parent)
        file_row.pack(fill="x", pady=(4, 16))
        ttk.Button(file_row, text="اختيار", command=self._choose_video).pack(side="left")
        ttk.Entry(file_row, textvariable=self.silence_source_var, justify="right").pack(
            side="right", fill="x", expand=True, padx=(8, 0)
        )

        self.silence_button = ttk.Button(
            parent,
            text="قص الصمت",
            command=self._cut_silence,
        )
        self.silence_button.pack(fill="x", ipady=7)
        ttk.Label(parent, textvariable=self.silence_status, foreground="#555555").pack(
            anchor="e", pady=(10, 0)
        )

    @staticmethod
    def _label(parent: ttk.Frame, text: str) -> ttk.Label:
        return ttk.Label(parent, text=text, font=("Segoe UI Semibold", 10), anchor="e")

    def _choose_output(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.output_var.get() or str(Path.home()))
        if selected:
            self.output_var.set(selected)

    def _choose_video(self) -> None:
        selected = filedialog.askopenfilename(
            filetypes=[
                ("Video", "*.mp4 *.mkv *.mov *.webm *.avi *.m4v"),
                ("All files", "*.*"),
            ]
        )
        if selected:
            self.silence_source_var.set(selected)

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
            yt_dlp = binary("yt-dlp.exe")
            ffmpeg = binary("ffmpeg.exe")
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        self._set_busy(True)
        self.download_status.set("جاري تحميل الجزء فقط...")

        def work() -> None:
            try:
                download_section(
                    yt_dlp=yt_dlp,
                    ffmpeg_dir=ffmpeg.parent,
                    url=url,
                    start=start,
                    end=end,
                    quality=quality,
                    output_dir=output,
                )
            except Exception as exc:
                error = str(exc)
                self.after(0, lambda error=error: self._finish_download(False, error, output))
            else:
                self.after(0, lambda: self._finish_download(True, "", output))

        threading.Thread(target=work, daemon=True).start()

    def _finish_download(self, success: bool, error: str, output: Path) -> None:
        self._set_busy(False)
        if success:
            self.download_status.set(f"تم ✓  —  {output}")
            messagebox.showinfo(APP_TITLE, f"تم التحميل.\n{output}")
        else:
            self.download_status.set("فشل التحميل")
            messagebox.showerror(APP_TITLE, error)

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

        self._set_busy(True)
        self.silence_status.set("جاري تحليل وقص الصمت...")

        def work() -> None:
            try:
                result = cut_silence(
                    ffmpeg=ffmpeg,
                    ffprobe=ffprobe,
                    source=source,
                )
            except Exception as exc:
                error = str(exc)
                self.after(0, lambda error=error: self._finish_silence(False, error, source))
            else:
                self.after(0, lambda: self._finish_silence(True, "", result))

        threading.Thread(target=work, daemon=True).start()

    def _finish_silence(self, success: bool, error: str, destination: Path) -> None:
        self._set_busy(False)
        if success:
            self.silence_status.set(f"تم ✓  —  {destination.name}")
            messagebox.showinfo(APP_TITLE, f"تم قص الصمت.\n{destination}")
        else:
            self.silence_status.set("فشل قص الصمت")
            messagebox.showerror(APP_TITLE, error)

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.download_button.configure(state=state)
        self.silence_button.configure(state=state)

    def _on_close(self) -> None:
        if self.busy:
            messagebox.showwarning(APP_TITLE, "استنى العملية الحالية تخلص الأول.")
            return
        self.destroy()


if __name__ == "__main__":
    MiniVideoTool().mainloop()
