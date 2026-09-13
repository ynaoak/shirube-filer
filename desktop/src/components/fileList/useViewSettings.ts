import { useState } from "react";
import { ViewMode } from "../../types/fileListTypes";
import type { GridItemSize } from "./viewZoom";

/**
 * 保存済みの表示形式を読む。
 *
 * 表示形式に「一覧（compact）」を足す前は "list"（＝現在の詳細表示）と "grid"
 * の2値だった。既存ユーザーの "list" をそのまま新しい一覧表示として解釈すると、
 * 更新しただけで見た目が勝手に変わってしまうので、詳細表示へ読み替える。
 */
function readViewMode(tabId: string): ViewMode {
  const saved = localStorage.getItem(`kf-view-mode-${tabId}`);
  if (saved === "grid" || saved === "compact" || saved === "details") return saved;
  return "details";
}

/** Display-preference state that persists in localStorage (view mode, grid size, date format). */
export function useViewSettings({ tabId }: { tabId: string }) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode(tabId));
  const [gridItemSize, setGridItemSize] = useState<GridItemSize>(() => {
    const v = Number(localStorage.getItem(`kf-grid-size-${tabId}`));
    return v === 64 || v === 96 || v === 128 ? v : 96;
  });
  const [dateRelative, setDateRelative] = useState(
    () => localStorage.getItem("kf-date-relative") === "1"
  );
  const [searchActive, setSearchActive] = useState(false);

  return {
    viewMode, setViewMode,
    gridItemSize, setGridItemSize,
    dateRelative, setDateRelative,
    searchActive, setSearchActive,
  };
}
