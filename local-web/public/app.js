const $ = (id) => document.getElementById(id);

const state = {
  url: "",
  metadata: null,
  sessionId: null,
  regions: [],
  outputPath: null,
  selectionStart: 0,
  selectionEnd: 0,
  duration: 0,
  sourceOffset: 0,
  width: 16,
  height: 9,
  captions: [],
  logo: {
    enabled: false,
    url: null,
    x: 0.78,
    y: 0.05,
    width: 0.18,
    opacity: 1,
    start: 0,
    end: 0,
  },
};

function setBusy(button, busy, text) {
  button.disabled = busy;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = busy ? text : button.dataset.label;
}

function error(id, message = "") {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

async function api(url, payload) {
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "حصل خطأ.");
  return data;
}

async function checkHealth() {
  try {
    await api("/api/health");
    $("health").textContent = "جاهز على جهازك";
    $("health").classList.add("ok");
  } catch {
    $("health").textContent = "الأدوات غير جاهزة";
  }
}

$("read-btn").addEventListener("click", async () => {
  error("source-error");
  const button = $("read-btn");
  try {
    setBusy(button, true, "جاري القراءة…");
    const url = $("youtube-url").value.trim();
    const metadata = await api("/api/metadata", { url });
    state.url = url;
    state.metadata = metadata;
    resetEditorState();
    $("title").textContent = metadata.title;
    $("duration").textContent = `المدة: ${formatTime(metadata.duration)}`;
    if (metadata.thumbnail) {
      $("thumb").src = metadata.thumbnail;
      $("thumb").classList.remove("hidden");
    }
    $("video-info").classList.remove("hidden");
    $("range-card").classList.remove("disabled");
    $("analysis-card").classList.remove("disabled");
    $("end").value = Math.min(metadata.duration, 60).toFixed(1);
    [...$("quality").options].forEach((option) => {
      option.disabled = option.value !== "best" && !metadata.qualities.includes(option.value);
    });
    if (!metadata.qualities.includes($("quality").value)) $("quality").value = "best";
  } catch (e) {
    error("source-error", e.message);
  } finally {
    setBusy(button, false, "");
  }
});

$("analyze-btn").addEventListener("click", async () => {
  error("analysis-error");
  if (!state.metadata) return;
  const button = $("analyze-btn");
  try {
    setBusy(button, true, "جاري تحميل الجزء وتحليله…");
    $("analysis-status").textContent = "سيتم استخدام موارد جهازك فقط.";
    const start = Number($("start").value);
    const end = Number($("end").value);
    const result = await api("/api/analyze", {
      url: state.url,
      start,
      end,
      quality: $("quality").value,
    });

    state.sessionId = result.sessionId;
    state.regions = result.regions;
    state.selectionStart = start;
    state.selectionEnd = end;
    state.duration = end - start;
    state.sourceOffset = result.sourceOffset;
    state.width = result.width || 16;
    state.height = result.height || 9;
    state.captions = [];
    state.logo = {
      enabled: false,
      url: null,
      x: 0.78,
      y: 0.05,
      width: 0.18,
      opacity: 1,
      start,
      end,
    };

    const preview = $("preview");
    preview.src = `${result.mediaUrl}?t=${Date.now()}`;
    $("video-stage").style.aspectRatio = `${state.width} / ${state.height}`;
    if (result.waveformUrl) {
      $("waveform").src = `${result.waveformUrl}?t=${Date.now()}`;
      $("waveform").classList.remove("hidden");
    } else {
      $("waveform").classList.add("hidden");
    }
    renderRegions(result.regions);
    renderTimeline();
    updateCaptionControls();
    updateLogoPreview();
    $("analysis-status").textContent = result.regions.length
      ? `اكتشفنا ${result.regions.length} منطقة صمت.`
      : "لم يتم اكتشاف صمت قابل للحذف.";
    $("editor-card").classList.remove("disabled");
    $("export-card").classList.remove("disabled");
  } catch (e) {
    error("analysis-error", e.message);
  } finally {
    setBusy(button, false, "");
  }
});

function resetEditorState() {
  state.sessionId = null;
  state.regions = [];
  state.outputPath = null;
  state.captions = [];
  state.logo.enabled = false;
  $("editor-card").classList.add("disabled");
  $("export-card").classList.add("disabled");
  $("silence-list").replaceChildren();
  $("done").classList.add("hidden");
}

function renderRegions(regions) {
  const root = $("silence-list");
  root.replaceChildren();
  regions.forEach((region, index) => {
    const label = document.createElement("label");
    label.className = "silence-item";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.index = String(index);
    input.addEventListener("change", renderTimeline);
    const text = document.createElement("span");
    text.textContent = `احذف الصمت: ${formatTime(region.start)} → ${formatTime(region.end)}`;
    label.append(input, text);
    root.append(label);
  });
}

function selectedRemovedRegions() {
  return [...document.querySelectorAll(".silence-item input:checked")]
    .map((input) => state.regions[Number(input.dataset.index)])
    .filter(Boolean);
}

const preview = $("preview");
preview.addEventListener("loadedmetadata", () => {
  const localStart = Math.max(0, state.selectionStart - state.sourceOffset);
  preview.currentTime = localStart;
  updatePlaybackUi();
});
preview.addEventListener("timeupdate", () => {
  const sourceTime = state.sourceOffset + preview.currentTime;
  if (state.sessionId && sourceTime > state.selectionEnd + 0.03) {
    preview.pause();
    preview.currentTime = Math.max(0, state.selectionEnd - state.sourceOffset);
  }
  updatePlaybackUi();
});
preview.addEventListener("seeked", updatePlaybackUi);

function updatePlaybackUi() {
  if (!state.sessionId || state.duration <= 0) return;
  const sourceTime = clamp(state.sourceOffset + preview.currentTime, state.selectionStart, state.selectionEnd);
  const fraction = clamp((sourceTime - state.selectionStart) / state.duration, 0, 1);
  $("timeline-playhead").style.left = `${fraction * 100}%`;
  $("timeline-time").textContent = `${formatTime(sourceTime - state.selectionStart)} / ${formatTime(state.duration)}`;
  updateCaptionPreview(sourceTime);
  updateLogoVisibility(sourceTime);
}

$("timeline-body").addEventListener("pointerdown", (event) => {
  if (!state.sessionId) return;
  const rect = $("timeline-body").getBoundingClientRect();
  const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const sourceTime = state.selectionStart + fraction * state.duration;
  preview.currentTime = Math.max(0, sourceTime - state.sourceOffset);
});

function renderTimeline() {
  if (!state.sessionId || state.duration <= 0) return;
  const silenceRoot = $("timeline-silence");
  const captionRoot = $("timeline-captions");
  const logoRoot = $("timeline-logo");
  silenceRoot.replaceChildren();
  captionRoot.replaceChildren();
  logoRoot.replaceChildren();

  const removed = selectedRemovedRegions();
  state.regions.forEach((region) => {
    const active = removed.some((candidate) => Math.abs(candidate.start - region.start) < 0.001 && Math.abs(candidate.end - region.end) < 0.001);
    silenceRoot.append(makeTimelineBlock(region.start, region.end, active ? "cut active" : "cut", "صمت"));
  });
  state.captions.forEach((cue) => captionRoot.append(makeTimelineBlock(cue.start, cue.end, "caption", cue.text)));
  if (state.logo.enabled) logoRoot.append(makeTimelineBlock(state.logo.start, state.logo.end, "logo", "لوجو"));
}

function makeTimelineBlock(start, end, className, title) {
  const block = document.createElement("div");
  const left = clamp((start - state.selectionStart) / state.duration, 0, 1);
  const right = clamp((end - state.selectionStart) / state.duration, 0, 1);
  block.className = `timeline-block ${className}`;
  block.style.left = `${left * 100}%`;
  block.style.width = `${Math.max(0.3, (right - left) * 100)}%`;
  block.title = title;
  return block;
}

$("logo-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file || !state.sessionId) return;
  error("export-error");
  try {
    const form = new FormData();
    form.append("sessionId", state.sessionId);
    form.append("file", file);
    const response = await fetch("/api/logo", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "تعذر رفع اللوجو محليًا.");
    state.logo.enabled = true;
    state.logo.url = `${data.logoUrl}?t=${Date.now()}`;
    state.logo.start = state.selectionStart;
    state.logo.end = state.selectionEnd;
    $("logo-start").value = state.logo.start.toFixed(1);
    $("logo-end").value = state.logo.end.toFixed(1);
    $("logo-controls").classList.remove("hidden");
    $("logo-overlay").src = state.logo.url;
    updateLogoPreview();
    renderTimeline();
  } catch (e) {
    error("export-error", e.message);
  }
});

$("logo-size").addEventListener("input", () => {
  state.logo.width = Number($("logo-size").value) / 100;
  updateLogoPreview();
});
$("logo-opacity").addEventListener("input", () => {
  state.logo.opacity = Number($("logo-opacity").value) / 100;
  updateLogoPreview();
});
$("logo-start").addEventListener("change", () => {
  state.logo.start = clamp(Number($("logo-start").value), state.selectionStart, state.selectionEnd);
  renderTimeline();
});
$("logo-end").addEventListener("change", () => {
  state.logo.end = clamp(Number($("logo-end").value), state.selectionStart, state.selectionEnd);
  renderTimeline();
});
$("remove-logo-btn").addEventListener("click", () => {
  state.logo.enabled = false;
  $("logo-overlay").classList.add("hidden");
  $("logo-controls").classList.add("hidden");
  $("logo-file").value = "";
  renderTimeline();
});

function updateLogoPreview() {
  const logo = $("logo-overlay");
  if (!state.logo.enabled || !state.logo.url) {
    logo.classList.add("hidden");
    return;
  }
  logo.classList.remove("hidden");
  logo.style.left = `${state.logo.x * 100}%`;
  logo.style.top = `${state.logo.y * 100}%`;
  logo.style.width = `${state.logo.width * 100}%`;
  logo.style.opacity = String(state.logo.opacity);
  updateLogoVisibility(clamp(state.sourceOffset + preview.currentTime, state.selectionStart, state.selectionEnd));
}

function updateLogoVisibility(sourceTime) {
  const logo = $("logo-overlay");
  const visible = state.logo.enabled && sourceTime >= state.logo.start && sourceTime <= state.logo.end;
  logo.classList.toggle("timeline-hidden", !visible);
}

let logoDrag = null;
$("logo-overlay").addEventListener("pointerdown", (event) => {
  if (!state.logo.enabled) return;
  event.preventDefault();
  const stage = $("video-stage").getBoundingClientRect();
  const logo = $("logo-overlay").getBoundingClientRect();
  logoDrag = {
    offsetX: (event.clientX - logo.left) / stage.width,
    offsetY: (event.clientY - logo.top) / stage.height,
  };
  $("logo-overlay").setPointerCapture(event.pointerId);
});
$("logo-overlay").addEventListener("pointermove", (event) => {
  if (!logoDrag) return;
  const rect = $("video-stage").getBoundingClientRect();
  state.logo.x = clamp((event.clientX - rect.left) / rect.width - logoDrag.offsetX, 0, 1 - state.logo.width);
  state.logo.y = clamp((event.clientY - rect.top) / rect.height - logoDrag.offsetY, 0, 0.9);
  updateLogoPreview();
});
$("logo-overlay").addEventListener("pointerup", () => { logoDrag = null; });
$("logo-overlay").addEventListener("pointercancel", () => { logoDrag = null; });

$("youtube-captions-btn").addEventListener("click", async () => {
  if (!state.sessionId) return;
  const button = $("youtube-captions-btn");
  try {
    setBusy(button, true, "جاري تحميل الكابشن…");
    const result = await api("/api/youtube-captions", { sessionId: state.sessionId });
    state.captions = normalizeCaptionCues(result.cues || [], false);
    updateCaptionControls();
    renderTimeline();
    updatePlaybackUi();
  } catch (e) {
    error("export-error", e.message);
  } finally {
    setBusy(button, false, "");
  }
});

$("caption-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const cues = parseSrt(await file.text());
    if (!cues.length) throw new Error("ملف SRT فارغ أو غير صالح.");
    state.captions = normalizeCaptionCues(cues, true);
    updateCaptionControls();
    renderTimeline();
    updatePlaybackUi();
  } catch (e) {
    error("export-error", e.message);
  }
});

$("clear-captions-btn").addEventListener("click", () => {
  state.captions = [];
  $("caption-file").value = "";
  updateCaptionControls();
  renderTimeline();
  updatePlaybackUi();
});
$("caption-size").addEventListener("input", updatePlaybackUi);
$("caption-position").addEventListener("change", updatePlaybackUi);

function normalizeCaptionCues(cues, inferClipRelative) {
  let normalized = cues.map((cue) => ({ start: Number(cue.start), end: Number(cue.end), text: String(cue.text || "").trim() }))
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.text);
  if (inferClipRelative && state.selectionStart > 0) {
    const maxEnd = Math.max(0, ...normalized.map((cue) => cue.end));
    if (maxEnd <= state.duration + 0.5) {
      normalized = normalized.map((cue) => ({ ...cue, start: cue.start + state.selectionStart, end: cue.end + state.selectionStart }));
    }
  }
  return normalized.filter((cue) => cue.end > state.selectionStart && cue.start < state.selectionEnd);
}

function updateCaptionControls() {
  $("caption-count").textContent = `${state.captions.length} كابشن`;
  $("caption-preview").classList.toggle("hidden", state.captions.length === 0);
}

function updateCaptionPreview(sourceTime) {
  const box = $("caption-preview");
  const cue = state.captions.find((candidate) => sourceTime >= candidate.start && sourceTime <= candidate.end);
  if (!cue) {
    box.classList.add("hidden");
    return;
  }
  box.textContent = cue.text;
  box.classList.remove("hidden");
  box.dataset.position = $("caption-position").value;
  box.style.fontSize = `${Math.max(16, Number($("caption-size").value) * 0.55)}px`;
}

function parseSrt(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];
  const cues = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [a, b] = lines[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const start = parseSrtTime(a);
    const end = parseSrtTime(b);
    const cueText = lines.slice(timeIndex + 1).join("\n").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && cueText) cues.push({ start, end, text: cueText });
  }
  return cues;
}

function parseSrtTime(value) {
  const match = String(value).match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0")) / 1000;
}

$("export-btn").addEventListener("click", async () => {
  error("export-error");
  if (!state.sessionId) return;
  const button = $("export-btn");
  try {
    setBusy(button, true, "جاري التصدير…");
    const logo = state.logo.enabled
      ? {
          x: state.logo.x,
          y: state.logo.y,
          width: state.logo.width,
          opacity: state.logo.opacity,
          start: state.logo.start,
          end: state.logo.end,
        }
      : null;
    const result = await api("/api/export", {
      sessionId: state.sessionId,
      removedRegions: selectedRemovedRegions(),
      title: state.metadata?.title || "final",
      logo,
      captions: state.captions,
      captionFontSize: Number($("caption-size").value),
      captionPosition: $("caption-position").value,
    });
    state.outputPath = result.outputPath;
    $("output-path").textContent = result.outputPath;
    $("download-link").href = result.downloadUrl;
    $("done").classList.remove("hidden");
    $("export-status").textContent = "التصدير اكتمل.";
  } catch (e) {
    error("export-error", e.message);
  } finally {
    setBusy(button, false, "");
  }
});

$("reveal-btn").addEventListener("click", async () => {
  if (!state.sessionId) return;
  try { await api("/api/reveal", { sessionId: state.sessionId }); } catch (e) { error("export-error", e.message); }
});

function formatTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

checkHealth();
