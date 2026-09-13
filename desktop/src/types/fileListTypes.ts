import { ConflictResolution } from "../components/dialogs/ConflictDialog";

export type ClipboardItem = { paths: string[]; mode: "copy" | "cut" };
export type SortKey = "name" | "size" | "modified" | "type" | "ext";
export type SortDir = "asc" | "desc";
/** ファイル一覧の表示形式。
 *  "details" = 詳細表示（列付きのテーブル）/
 *  "compact" = 一覧表示（アイコンと名前だけを多段に詰める）/
 *  "grid"    = サムネイル表示（大きさは gridItemSize） */
export type ViewMode = "details" | "compact" | "grid";
export type FilterPreset = "all" | "folders" | "images" | "code" | "text" | "archives" | "microsoft";

export type CustomMenuItem = {
  id: string;
  label: string;
  icon: string;
  command: string;
  on: "all" | "file" | "dir";
};

export type ConflictInfo = {
  files: Array<{ src: string; dest: string }>;
  resolve: (r: ConflictResolution) => void;
};
