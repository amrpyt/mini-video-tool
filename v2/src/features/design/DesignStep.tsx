import { convertFileSrc } from "@tauri-apps/api/core";

import type { EditorAction } from "../../app/editorReducer";
import type { EditorOverlay, TimeRange } from "../../lib/types";
import { clampGeometry } from "./overlayGeometry";

interface DesignStepProps {
  selection: TimeRange | null;
  overlays: EditorOverlay[];
  selectedOverlayId: string | null;
  onSelectOverlay: (id: string | null) => void;
  dispatch: (action: EditorAction) => void;
  chooseImage: () => Promise<string | null>;
  canvasAspectRatio?: number;
}

let nextOverlayId = 1;

export function DesignStep({
  selection,
  overlays,
  selectedOverlayId,
  onSelectOverlay,
  dispatch,
  chooseImage,
  canvasAspectRatio = 16 / 9,
}: DesignStepProps) {
  const selected = overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;
  const canAdd = selection !== null;

  function addBlackBar() {
    if (!selection) return;
    const overlay: EditorOverlay = {
      id: `overlay-${nextOverlayId++}`,
      kind: "blackBar",
      range: { ...selection },
      geometry: { x: 0.08, y: 0.76, width: 0.84, height: 0.14 },
      opacity: 0.85,
      assetPath: null,
      aspectLocked: false,
    };
    dispatch({ type: "overlay/add", overlay });
    onSelectOverlay(overlay.id);
  }

  async function addImage() {
    if (!selection) return;
    const path = await chooseImage();
    if (!path) return;
    const aspect = await imageAspectRatio(path).catch(() => 1);
    const normalizedAspect = aspect / Math.max(0.01, canvasAspectRatio);
    const width = 0.25;
    const overlay: EditorOverlay = {
      id: `overlay-${nextOverlayId++}`,
      kind: "image",
      range: { ...selection },
      geometry: clampGeometry(
        {
          x: 0.68,
          y: 0.08,
          width,
          height: width / Math.max(0.1, normalizedAspect),
        },
        normalizedAspect,
      ),
      opacity: 1,
      assetPath: path,
      aspectLocked: true,
    };
    dispatch({ type: "overlay/add", overlay });
    onSelectOverlay(overlay.id);
  }

  return (
    <div className="inspector-stack">
      <div className="inspector-section">
        <h3>إضافة عنصر</h3>
        <p className="inspector-help">العناصر تظهر داخل زمن المصدر المحدد فقط، بدون أي رندر أثناء التعديل.</p>
        <div className="design-add-actions">
          <button type="button" className="primary-button" disabled={!canAdd} onClick={() => void addImage()}>
            إضافة صورة / لوجو
          </button>
          <button type="button" className="secondary-button" disabled={!canAdd} onClick={addBlackBar}>
            إضافة شريط أسود
          </button>
        </div>
      </div>

      <div className="inspector-section">
        <h3>العناصر</h3>
        {overlays.length === 0 ? (
          <p className="inspector-help">لا توجد عناصر تصميم بعد.</p>
        ) : (
          <div className="overlay-list">
            {overlays.map((overlay, index) => (
              <button
                key={overlay.id}
                type="button"
                className={overlay.id === selectedOverlayId ? "overlay-list-item selected" : "overlay-list-item"}
                onClick={() => onSelectOverlay(overlay.id)}
              >
                {overlay.kind === "image" ? "صورة" : "شريط أسود"} {index + 1}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <div className="inspector-section">
          <h3>خصائص العنصر</h3>
          <label className="field-label" htmlFor="overlay-opacity">
            الشفافية
          </label>
          <input
            id="overlay-opacity"
            aria-label="الشفافية"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={selected.opacity}
            onChange={(event) =>
              dispatch({
                type: "overlay/updateOpacity",
                id: selected.id,
                opacity: Number(event.currentTarget.value),
              })
            }
          />
          <label className="checkbox-row">
            <input
              aria-label="تثبيت النسبة"
              type="checkbox"
              checked={selected.aspectLocked}
              onChange={(event) =>
                dispatch({
                  type: "overlay/setAspectLock",
                  id: selected.id,
                  locked: event.currentTarget.checked,
                })
              }
            />
            تثبيت النسبة
          </label>
          <button
            type="button"
            className="danger-button"
            onClick={() => {
              dispatch({ type: "overlay/remove", id: selected.id });
              onSelectOverlay(null);
            }}
          >
            حذف العنصر
          </button>
        </div>
      ) : null}
    </div>
  );
}

async function imageAspectRatio(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth / Math.max(1, image.naturalHeight));
    image.onerror = () => reject(new Error("image dimensions unavailable"));
    image.src = convertFileSrc(path);
  });
}
