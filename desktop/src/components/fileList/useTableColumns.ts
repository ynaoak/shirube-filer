import { useCallback, useEffect, useRef, useState } from "react";
import { OptionalCol } from "./constants";

type ColWidths = { size: number; modified: number; ext: number; type: number };

/** Manages column widths, column visibility, the column header context menu, and the resize drag handler. */
export function useTableColumns({ tabId }: { tabId: string }) {
  const [colWidths, setColWidths] = useState<ColWidths>(() => {
    const raw = localStorage.getItem(`kf-col-widths-${tabId}`);
    // 更新日は "2026/12/15" のような絶対日付が省略されずに収まる幅を既定にする
    return raw ? (JSON.parse(raw) as ColWidths) : { size: 76, modified: 110, ext: 48, type: 48 };
  });

  const [visibleCols, setVisibleCols] = useState<Set<OptionalCol>>(() => {
    const saved = localStorage.getItem(`kf-visible-cols-${tabId}`);
    if (saved) {
      try { return new Set(JSON.parse(saved) as OptionalCol[]); } catch {}
    }
    return new Set<OptionalCol>(["size", "modified"]);
  });

  const [headerMenuPos, setHeaderMenuPos] = useState<{ x: number; y: number } | null>(null);
  const colResizeRef = useRef<{ col: keyof ColWidths; startX: number; startW: number } | null>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // Close header menu on outside click.
  useEffect(() => {
    if (!headerMenuPos) return;
    const onDown = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setHeaderMenuPos(null);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [headerMenuPos]);

  const startColResize = useCallback(
    (col: keyof ColWidths, startX: number) => {
      colResizeRef.current = { col, startX, startW: colWidths[col] };
      function onMove(e: MouseEvent) {
        if (!colResizeRef.current) return;
        const { col: c, startX: sx, startW: sw } = colResizeRef.current;
        const next = Math.max(40, sw + e.clientX - sx);
        setColWidths((prev) => {
          const updated = { ...prev, [c]: next };
          localStorage.setItem(`kf-col-widths-${tabId}`, JSON.stringify(updated));
          return updated;
        });
      }
      function onUp() {
        colResizeRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [colWidths, tabId]
  );

  return {
    colWidths, setColWidths,
    visibleCols, setVisibleCols,
    headerMenuPos, setHeaderMenuPos,
    colResizeRef,
    headerMenuRef,
    startColResize,
  };
}
