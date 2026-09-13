import { useCallback, useRef, useState } from "react";
import FileTreePanel from "../panels/FileTreePanel";
import DrivePanel from "../panels/DrivePanel";
import BookmarkPanel from "../panels/BookmarkPanel";
import type { LeftPanelTab } from "./ActivityBar";

const MIN_WIDTH = 160;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 220;
const LS_KEY = "kf-left-panel-width";

type Props = {
  tab: LeftPanelTab;
  currentPath: string;
  onNavigate: (path: string) => void;
};

export default function LeftSidePanel({ tab, currentPath, onNavigate }: Props) {
  const [width, setWidth] = useState<number>(() => {
    const saved = localStorage.getItem(LS_KEY);
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return isNaN(parsed) ? DEFAULT_WIDTH : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
  });

  const widthRef = useRef(width);
  widthRef.current = width;
  const dragStartXRef = useRef<number | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartXRef.current = e.clientX;
    const startWidth = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      if (dragStartXRef.current === null) return;
      const delta = ev.clientX - dragStartXRef.current;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(newWidth);
      localStorage.setItem(LS_KEY, String(newWidth));
    };
    const onUp = () => {
      dragStartXRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div
      className="flex-shrink-0 flex flex-col border-r overflow-hidden relative"
      style={{
        width,
        backgroundColor: "var(--kf-bg-secondary)",
        borderColor: "var(--kf-border)",
      }}
    >
      {/* リサイズハンドル */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500 hover:opacity-60"
        style={{ touchAction: "none" }}
        onMouseDown={handleDragStart}
      />

      {/* コンテンツ */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === "tree" && (
          <FileTreePanel
            currentPath={currentPath}
            onNavigate={onNavigate}
            onClose={() => {}}
            controlled
          />
        )}
        {tab === "home" && (
          <DrivePanel
            onNavigate={onNavigate}
            onClose={() => {}}
            controlled
          />
        )}
        {tab === "bookmark" && (
          <BookmarkPanel
            currentPath={currentPath}
            onNavigate={onNavigate}
            controlled
          />
        )}
      </div>
    </div>
  );
}
