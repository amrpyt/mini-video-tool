# Mini Video Tool v2 — Cutover Checklist

التاريخ: 2026-10-06
الفرع: `feat/tauri-v2-editor`
جهاز القياس: Intel Core Ultra 5 125H + Intel Arc Graphics، Windows x64.

الحالة العامة: **v2 اجتاز بوابات الكود والـsmoke والـGUI acceptance على جهاز الهدف.** النسخة القديمة لم تُحذف، والإصدار المنشور لم يتغير ضمن هذه المهمة.

## تحقق آلي

| البند | النتيجة | الدليل |
| --- | --- | --- |
| Rust unit/integration | PASS | `cargo test --manifest-path v2/src-tauri/Cargo.toml --no-fail-fast` |
| Rust strict lint | PASS | `cargo clippy ... --all-targets -- -D warnings` |
| Rust format | PASS | `cargo fmt ... --check` |
| React/Vitest | PASS | `npm test -- --run` |
| TypeScript/Vite build | PASS | `npm run build` |
| Sidecar staging | PASS | ffmpeg + ffprobe + yt-dlp staged for `x86_64-pc-windows-msvc` |
| Local backend smoke | PASS | probe → selection → silence → overlay → captions → one final encode → ffprobe → cleanup |
| Debug Tauri package | PASS | EXE + MSI + NSIS built successfully |
| Release Tauri package | PASS | MSI `150.91 MiB` + NSIS `103.68 MiB` built successfully |

## سلامة البيانات والمسارات

- [x] زمن المشروع integer microseconds؛ معدل `30000/1001` لا يتحول إلى float storage.
- [x] مسارات Unicode + مسافات تختبر فعليًا في probe/export.
- [x] فيديو بلا صوت مدعوم، وتحليل الصمت يرجع typed unsupported قبل spawn.
- [x] المشروع يفتح حتى لو المصدر المحلي اختفى؛ التعديلات تظل محفوظة ويظهر SourceUnavailable.
- [x] حفظ المشروع ذري: sibling temp + sync + atomic replace؛ فشل الحفظ لا يمس آخر نسخة صالحة.
- [x] autosave بعد 750ms لتعديلات المشروع فقط؛ playhead لا يسبب autosave؛ الكتابات المتداخلة serialized.
- [x] لا يمكن اختيار ملف المصدر نفسه كوجهة التصدير.
- [x] الإلغاء/الفشل لا يستبدل ملف إخراج سابق صالح.

## عمليات الوسائط

- [x] عملية ثقيلة واحدة فقط: Download أو Silence Analysis أو Export.
- [x] PID للعملية الثقيلة مسجل في JobManager؛ الإلغاء يقتل process tree ويمنع stale success.
- [x] أدوات probe/metadata/preview/filmstrip/encoder-detection/YouTube-captions تسجل PIDs الخفيفة في **نفس** JobManager بدون استهلاك خانة العملية الثقيلة، وتُنظف عند الخروج.
- [x] اختيار جودة يوتيوب لا يبدأ تنزيلًا.
- [x] metadata-only يسبق تنزيل يوتيوب.
- [x] طلب يوتيوب مساوي للمصدر كاملًا مرفوض بدل تنزيل الفيديو كاملًا.
- [x] `sourceOffset` يحافظ على زمن المصدر عند keyframe preroll.
- [x] تحليل الصمت يستخدم FFmpeg واحدًا لإخراج silencedetect + waveform image، بدون video encode.
- [x] تغيير قرارات الصمت بعد التحليل محلي ولا يعيد التحليل.
- [x] سحب playhead/overlay، تغيير caption style، تغيير الخطوات، تعديل in/out، وحفظ المشروع لا يبدأ final media render.

## التصدير النهائي

- [x] keep segments تتكون من `selection - accepted silence` وتُدمج قبل بناء graph.
- [x] الصوت والصورة يمران في نفس concat عند وجود audio؛ no-audio graph لا يشير لمسار صوت.
- [x] overlays والكابشن يضافان في نفس filter graph النهائي.
- [x] `-/filter_complex <file>` مستخدم بدل command line ضخمة.
- [x] exactly one final video encoder output في مسار النجاح العادي.
- [x] QSV من 1280×720 تقريبًا عند توفره؛ fallback إلى x264 فقط عند فشل تهيئة QSV قبل إخراج مفيد.
- [x] ffprobe validation قبل النشر يفحص الأبعاد، المدة ضمن tolerance، والصوت عندما يكون مطلوبًا.
- [x] الخط المختار يُقرأ اسمه الداخلي من ملف الخط لضمان parity مع libass بدل الاعتماد على اسم الملف.

## Smoke حقيقي — يوتيوب

تم على 2026-10-06 باستخدام فيديو عام قصير متاح وقت الاختبار: `jNQXAC9IVRw`، النطاق 1–6 ثوانٍ، جودة 360p.

- [x] metadata-only نجح أولًا: العنوان `Me at the zoo`، المدة 19 ثانية.
- [x] بعد metadata لم يوجد أي media artifact.
- [x] تنزيل النطاق الجزئي فقط نجح.
- [x] ffprobe للنطاق الجزئي نجح.
- [x] مجلد الاختبار احتوى media artifact واحدًا فقط؛ لا يوجد full-source video.
- [x] مجلد الاختبار المؤقت نُظف بعد النهاية.

## مقارنة أداء v1 / v2

قياس جديد على نفس جهاز الهدف. كل حالة استخدمت fixture مدته 8 ثوانٍ، 30fps، H.264 + AAC، ونفس المصدر للنسختين. القياس يقارن **أمر التصدير النهائي نفسه**؛ لا يشمل توليد fixture أو وقت compilation. سياسة كل نسخة الأصلية مستخدمة: CPU عند 360p وIntel QSV عند 720p/1080p.

| الدقة | v1 | v2 | v2 مقابل v1 |
| --- | ---: | ---: | ---: |
| 360p | 1.294s | 0.434s | أسرع ≈66.5% |
| 720p | 1.796s | 1.142s | أسرع ≈36.4% |
| 1080p | 1.734s | 1.650s | أسرع ≈4.8% |

النتيجة: لا يوجد regression في الحالات الثلاث المقاسة على جهاز الهدف.

## GUI acceptance — نافذة التطبيق الفعلية

تم على debug build الفعلي باستخدام نافذة Tauri/WebView2 الحقيقية على جهاز الهدف، مع mouse events فعلية للسحب داخل WebView2 وSendKeys لنافذة الحفظ الأصلية ومراقبة عمليات Windows:

- [x] Source → Range → Skip Silence → Design → Captions → Export اكتمل من الواجهة الفعلية؛ التحديد كان `00:00:02.000 — 00:00:18.184` والمصدر المحلي ظاهر في ملخص التصدير، بدون ملفات وسيطة مطلوبة من المستخدم.
- [x] full-source timeline ظل ظاهرًا بمدة `00:00:20.000`، وطبقتا التحديد في overview/window كانتا مرسومتين فعليًا بعرض يقارب `849–850px`.
- [x] سحب playhead، سحب overlay فعليًا، وتغيير caption size من `4.5` إلى `5` لم يُظهر أي FFmpeg خلال مراقبة process متكررة كل `25–50ms`. سحب الـoverlay غيّر موضعه من `8.4965% / 78.9175%` إلى `13.6558% / 65.8575%`.
- [x] Stop Operation اختُبر أثناء export حقيقي: FFmpeg بدأ، زر الإيقاف ضُغط بعد `84ms` من بدء الطلب، الحالة انتهت `ملغاة`، التطبيق ظل مفتوحًا، وبصمة SHA-256 للـoutput السابق بقيت `530FB69E8B9D8529D2869EF18DEE2A35427457B1E93E4ABCBA34AEDC8127B48B` بدون تغيير.
- [x] RTL/LTR قابلان للاستخدام عند 1440×900 وعند outer window 1100×720: document direction بقي `rtl`، حقلا الزمن `ltr`، وحقل البداية استقبل focus فعليًا عند المقاس الأدنى.

## قرار التحويل

- **Preview build:** GO.
- **Cutover readiness:** GO حسب بنود هذه الخطة.
- **استبدال v1 / تغيير latest release:** لم يُنفذ في هذه المهمة، عمدًا طبقًا للـbrief.
- **حذف v1:** ممنوع في هذه المرحلة طبقًا لخطة التحويل.
