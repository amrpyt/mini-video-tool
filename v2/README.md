# Mini Video Tool v2

نسخة ويندوز الجديدة مبنية بـ Tauri + React + Rust. النسخة القديمة ما زالت موجودة ولم يتم استبدال الإصدار المنشور بها بعد.

## ما الذي يعمل

- ملف محلي أو رابط يوتيوب مع قراءة البيانات قبل أي تنزيل.
- تحديد البداية والنهاية على خط زمني بزمن المصدر الأصلي.
- تنزيل **الجزء المحدد فقط** من يوتيوب؛ لا يوجد fallback لتنزيل الفيديو كاملًا.
- تحليل الصمت مرة واحدة، ثم قبول/رفض/تقسيم/دمج مناطق الحذف محليًا.
- صورة ثابتة أو PNG أو شريط أسود فوق الفيديو مع تحريك/تحجيم مباشر.
- SRT/ASS أو كابشن يوتيوب عربي، مع إعدادات الخط والألوان والحد والظل والخلفية والمحاذاة.
- تصدير MP4/H.264 في مخطط FFmpeg نهائي واحد؛ CPU للفيديو الصغير وIntel Quick Sync من 720p تقريبًا عند توفره، مع fallback للـCPU عند فشل تهيئة QSV فقط.
- حفظ/فتح مشروع `.mvt` وحفظ استعادة تلقائي بعد 750ms من تعديل المشروع.
- لوحة عملية موحدة للتنزيل/التحليل/التصدير، مع إلغاء آمن وعدم استبدال ملف نهائي صالح عند الفشل أو الإلغاء.

## المتطلبات

- Windows x64.
- Node/npm لبناء الواجهة.
- Rust MSVC toolchain لبناء Tauri.
- `ffmpeg.exe` و`ffprobe.exe` و`yt-dlp.exe` في `bin` بالريبو الرئيسي عند البناء من السورس. سكربت staging ينسخهم لأسماء sidecar المطلوبة.

## التحقق الكامل

من جذر `v2`:

```powershell
npm run stage:sidecars
cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
npm test -- --run
npm run build
```

اختبار backend محلي حقيقي:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-local.ps1
```

الاختبار ينشئ fixture صغيرًا، ثم يمر على: probe → selection → silence decision → overlay → captions → **ترميز نهائي واحد** → ffprobe → cleanup.

اختبار يوتيوب اختياري ويحتاج شبكة:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-youtube.ps1 `
  -Url "https://www.youtube.com/watch?v=<id>" -Start 1 -End 6 -Quality 360
```

السكربت يعمل metadata-only أولًا، ويتأكد أنه لم ينزل وسائط، ثم ينزل النطاق المحدد فقط ويفحصه بـ ffprobe ويتأكد أن ملف المصدر الكامل غير موجود.

## بناء التطبيق

```powershell
npm run stage:sidecars
.\node_modules\.bin\tauri.cmd build --debug
```

الناتج يكون تحت `src-tauri\target\debug\bundle`. للبناء النهائي احذف `--debug`.

## اختصارات

- `I`: اجعل بداية التحديد عند المؤشر.
- `O`: اجعل نهاية التحديد عند المؤشر.
- السهمان: إطار سابق/تالٍ.
- `Ctrl+Z`: تراجع.
- `Ctrl+Y` أو `Ctrl+Shift+Z`: إعادة.
- `Space`: تشغيل/إيقاف المعاينة المحلية.

الاختصارات لا تعمل أثناء الكتابة داخل الحقول. واجهة المحرر RTL وحقول الزمن/المسارات LTR حيث يلزم.

## حالة التحويل من v1

راجع `docs/superpowers/v2-cutover-checklist.md`. تم إغلاق GUI acceptance على جهاز الهدف، لكن هذه المهمة لا تحذف v1 ولا تغيّر الإصدار المنشور أو `latest`؛ أي cutover نشر فعلي يظل خطوة منفصلة وصريحة.
