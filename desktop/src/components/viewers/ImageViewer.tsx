import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";
import { ExifData, EXIF_EXTS, hasAnyExif, ExifTable } from "./ExifTable";

type Props = {
  path: string;
  siblings: string[]; // full paths of image siblings in the same directory
  onClose: () => void;
};

export default function ImageViewer({ path, siblings, onClose }: Props) {
  const { t } = useTranslation();
  // Escape / 矢印キーは本コンポーネントの keydown で処理するため closeOnEsc は無効。
  const dialogRef = useModal<HTMLDivElement>({ onClose, closeOnEsc: false });
  const [currentPath, setCurrentPath] = useState(path);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);
  const [exifData, setExifData] = useState<ExifData | null>(null);
  const [showExif, setShowExif] = useState(false);

  const currentIndex = siblings.indexOf(currentPath);
  const name = currentPath.split(/[\\/]/).pop() ?? currentPath;

  const goTo = useCallback((idx: number) => {
    if (idx < 0 || idx >= siblings.length) return;
    setCurrentPath(siblings[idx]);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [siblings]);

  const goPrev = useCallback(() => goTo(currentIndex - 1), [goTo, currentIndex]);
  const goNext = useCallback(() => goTo(currentIndex + 1), [goTo, currentIndex]);

  // 画像が変わるたび EXIF を読み込む（持たない形式・解析失敗は無視）。
  useEffect(() => {
    setExifData(null);
    setShowExif(false);
    const ext = currentPath.split(".").pop()?.toLowerCase() ?? "";
    if (!EXIF_EXTS.has(ext)) return;
    let cancelled = false;
    invoke<ExifData>("get_exif_data", { path: currentPath })
      .then((d) => { if (!cancelled && hasAnyExif(d)) setExifData(d); })
      .catch(() => { /* EXIF なし — 無視 */ });
    return () => { cancelled = true; };
  }, [currentPath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "Escape") onClose();
      else if (e.key === "0") { setScale(1); setOffset({ x: 0, y: 0 }); }
      else if (e.key === "i" || e.key === "I") setShowExif((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, onClose]);

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setScale((s) => Math.max(0.1, Math.min(16, s * factor)));
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    dragStartRef.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y };
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!dragging || !dragStartRef.current) return;
    const { mx, my, ox, oy } = dragStartRef.current;
    setOffset({ x: ox + e.clientX - mx, y: oy + e.clientY - my });
  }

  function onMouseUp() {
    setDragging(false);
    dragStartRef.current = null;
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("imageViewer.title", "画像ビューア")}
      className="kf-anim-fade fixed inset-0 z-50 flex flex-col"
      style={{ backgroundColor: "rgba(0,0,0,0.92)" }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-2 shrink-0"
        style={{ backgroundColor: "rgba(0,0,0,0.5)", color: "#fff" }}
      >
        <Icon name="image" size={15} style={{ color: "var(--kf-accent)" }} />
        <span className="flex-1 truncate text-sm font-medium">{name}</span>
        <span className="text-xs opacity-60">
          {currentIndex + 1} / {siblings.length}
        </span>
        <span className="text-xs opacity-60 ml-2">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}
          title={t("imageViewer.actualSize")}
          className="opacity-60 hover:opacity-100 flex items-center ml-1"
        >
          <Icon name="zoom_out_map" size={17} />
        </button>
        {exifData && (
          <button
            onClick={() => setShowExif((v) => !v)}
            title={`${t("preview.exifInfo")} (i)`}
            className="hover:opacity-100 flex items-center ml-1"
            style={{ opacity: showExif ? 1 : 0.6, color: showExif ? "var(--kf-accent)" : undefined }}
          >
            <Icon name="info" size={17} />
          </button>
        )}
        <button aria-label={t("common.close")} onClick={onClose} className="opacity-60 hover:opacity-100 flex items-center">
          <Icon name="close" size={17} />
        </button>
      </div>

      {/* Image area */}
      <div
        className="flex-1 overflow-hidden relative flex items-center justify-center"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{ cursor: dragging ? "grabbing" : scale > 1 ? "grab" : "default" }}
      >
        <img
          src={convertFileSrc(currentPath)}
          alt={name}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: "center center",
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            userSelect: "none",
            pointerEvents: "none",
          }}
        />

        {/* EXIF オーバーレイ（i キー / ツールバーのℹボタンで切替） */}
        {showExif && exifData && (
          <div
            className="absolute top-3 right-3 z-10 w-72 max-h-[82%] overflow-y-auto rounded-lg shadow-2xl py-2"
            style={{ backgroundColor: "var(--kf-bg-primary)", border: "1px solid var(--kf-border)" }}
          >
            <ExifTable data={exifData} />
          </div>
        )}

        {/* Prev/Next arrows */}
        {currentIndex > 0 && (
          <button aria-label={t("common.previous", "前へ")}
            onClick={goPrev}
            className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-full opacity-60 hover:opacity-100"
            style={{ width: 40, height: 40, backgroundColor: "rgba(0,0,0,0.5)", color: "#fff" }}
          >
            <Icon name="chevron_left" size={24} />
          </button>
        )}
        {currentIndex < siblings.length - 1 && (
          <button aria-label={t("common.next", "次へ")}
            onClick={goNext}
            className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-full opacity-60 hover:opacity-100"
            style={{ width: 40, height: 40, backgroundColor: "rgba(0,0,0,0.5)", color: "#fff" }}
          >
            <Icon name="chevron_right" size={24} />
          </button>
        )}
      </div>

      {/* Thumbnail strip */}
      {siblings.length > 1 && (
        <div
          className="flex items-center gap-1 px-3 py-2 overflow-x-auto shrink-0"
          style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          {siblings.map((p, i) => (
            <button
              key={p}
              onClick={() => goTo(i)}
              className="rounded overflow-hidden shrink-0"
              style={{
                width: 40,
                height: 40,
                border: p === currentPath ? "2px solid var(--kf-accent)" : "2px solid transparent",
                opacity: p === currentPath ? 1 : 0.5,
              }}
            >
              <img
                src={convertFileSrc(p)}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
