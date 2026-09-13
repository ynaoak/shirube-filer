import { createContext, useContext } from "react";
import type { ViewMode } from "../types/fileListTypes";

export type ClipboardStatus = {
  count: number;
  mode: "copy" | "cut";
};

/**
 * グローバル状態（フッタ表示用）。
 * - `totalCount` はフィルタ後（＝画面に出ている）件数
 * - `unfilteredCount` はフィルタ前の総件数。`isFiltered=true` のときだけ意味がある
 * - `viewMode` / `sortKey` / `sortDir` はステータスバー右側のインジケータ
 */
export type StatusInfo = {
  selectedCount: number;
  totalCount: number;
  folderCount: number;
  fileCount: number;
  selectedSize: number;
  clipboard: ClipboardStatus | null;
  /** Transient error message (auto-cleared by the caller after a few seconds). */
  error: string | null;
  /** Pre-filter total entries in the directory. */
  unfilteredCount: number;
  /** Hidden entries excluded from view (shown only if >0). */
  hiddenCount: number;
  /** True when search / preset / size / date filters are narrowing the list. */
  isFiltered: boolean;
  /** Current view mode of the active pane. */
  viewMode: ViewMode | null;
  /** Current sort indicator. */
  sortKey: "name" | "size" | "modified" | "ext" | "type" | null;
  sortDir: "asc" | "desc" | null;
};

export const defaultStatus: StatusInfo = {
  selectedCount: 0,
  totalCount: 0,
  folderCount: 0,
  fileCount: 0,
  selectedSize: 0,
  clipboard: null,
  error: null,
  unfilteredCount: 0,
  hiddenCount: 0,
  isFiltered: false,
  viewMode: null,
  sortKey: null,
  sortDir: null,
};

export const StatusContext = createContext<{
  status: StatusInfo;
  setStatus: (patch: Partial<StatusInfo>) => void;
}>({
  status: defaultStatus,
  setStatus: () => {},
});

export function useStatus() {
  return useContext(StatusContext);
}
