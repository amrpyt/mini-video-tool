const $ = (id) => document.getElementById(id);
const state = { metadata: null, sessionId: null, regions: [], outputPath: null };

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
    const metadata = await api("/api/metadata", { url: $("youtube-url").value });
    state.metadata = metadata;
    state.sessionId = null;
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
    const result = await api("/api/analyze", {
      url: $("youtube-url").value,
      start: Number($("start").value),
      end: Number($("end").value),
      quality: $("quality").value,
    });
    state.sessionId = result.sessionId;
    state.regions = result.regions;
    $("preview").src = result.mediaUrl;
    $("preview-wrap").classList.remove("hidden");
    if (result.waveformUrl) {
      $("waveform").src = `${result.waveformUrl}?t=${Date.now()}`;
      $("waveform").classList.remove("hidden");
    }
    renderRegions(result.regions);
    $("analysis-status").textContent = result.regions.length
      ? `اكتشفنا ${result.regions.length} منطقة صمت.`
      : "لم يتم اكتشاف صمت قابل للحذف.";
    $("export-card").classList.remove("disabled");
  } catch (e) {
    error("analysis-error", e.message);
  } finally {
    setBusy(button, false, "");
  }
});

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
    const text = document.createElement("span");
    text.textContent = `احذف الصمت: ${formatTime(region.start)} → ${formatTime(region.end)}`;
    label.append(input, text);
    root.append(label);
  });
}

$("export-btn").addEventListener("click", async () => {
  error("export-error");
  if (!state.sessionId) return;
  const button = $("export-btn");
  try {
    setBusy(button, true, "جاري التصدير…");
    const removedRegions = [...document.querySelectorAll(".silence-item input:checked")]
      .map((input) => state.regions[Number(input.dataset.index)]);
    const result = await api("/api/export", {
      sessionId: state.sessionId,
      removedRegions,
      title: state.metadata?.title || "final",
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

checkHealth();

\n