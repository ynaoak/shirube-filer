import { useTranslation } from "react-i18next";
import { ViewMode } from "../../types/fileListTypes";
import Icon from "../common/Icon";

/** 表示形式ボタンを1回押したときの遷移先。 */
const NEXT_VIEW: Record<ViewMode, ViewMode> = {
  details: "compact",
  compact: "grid",
  grid: "details",
};

/** 今の表示形式を表すアイコン。 */
const VIEW_ICON: Record<ViewMode, string> = {
  details: "view_list",
  compact: "view_headline",
  grid: "grid_view",
};

const VIEW_LABEL_KEY: Record<ViewMode, string> = {
  details: "fileList.viewDetails",
  compact: "fileList.viewCompact",
  grid: "fileList.viewGrid",
};

type Props = {
  tabId: string;
  viewMode: ViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  gridItemSize: 64 | 96 | 128;
  setGridItemSize: React.Dispatch<React.SetStateAction<64 | 96 | 128>>;
  showTreemap: boolean;
  setShowTreemap: React.Dispatch<React.SetStateAction<boolean>>;
  onRefresh: () => void;
  syncNavEnabled: boolean;
  setSyncNavEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  /** 狭いペインでは副次的なボタンを畳み、検索欄に幅を譲る。
   *  畳むのは表示トグル（ツリーマップ・ペイン同期）だけで、
   *  一覧/グリッド切替と更新は常に残す。 */
  compact?: boolean;
};

// ツールバー右側のビュー操作群（一覧/グリッド切替・グリッドサイズ・ツリーマップ・
// 更新・ペイン同期ナビ）。表示状態のトグルのみで、ディレクトリ読み込みには関与しない。
export default function FileListViewControls({
  tabId, viewMode, setViewMode, gridItemSize, setGridItemSize,
  showTreemap, setShowTreemap, onRefresh, syncNavEnabled, setSyncNavEnabled,
  compact = false,
}: Props) {
  const { t } = useTranslation();
  return (
    <>
      {/* ビュー切替（詳細 → 一覧 → サムネイル を順に回す） */}
      <button
        onClick={() => setViewMode((v) => {
          const next = NEXT_VIEW[v];
          localStorage.setItem(`kf-view-mode-${tabId}`, next);
          return next;
        })}
        className="flex items-center px-1 py-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
        style={{ color: viewMode === "details" ? "var(--kf-text-muted)" : "var(--kf-accent)" }}
        // ボタンには「押したら何になるか」を出す（今の状態はアイコンで分かる）。
        title={t(VIEW_LABEL_KEY[NEXT_VIEW[viewMode]])}
      >
        <Icon name={VIEW_ICON[viewMode]} size={16} />
      </button>
      {/* グリッドサイズ切替（グリッドモード時のみ） */}
      {viewMode === "grid" && (
        <button
          onClick={() => {
            const next = gridItemSize === 64 ? 96 : gridItemSize === 96 ? 128 : 64;
            setGridItemSize(next);
            localStorage.setItem(`kf-grid-size-${tabId}`, String(next));
          }}
          className="flex items-center px-1 py-0.5 rounded opacity-50 hover:opacity-100 transition-opacity text-[10px] font-mono"
          style={{ color: "var(--kf-text-muted)" }}
          title={t("fileList.gridSizeToggle")}
        >
          {gridItemSize}px
        </button>
      )}
      {/* ツリーマップボタン */}
      {!compact && (
      <button
        onClick={() => setShowTreemap((v) => !v)}
        className="flex items-center px-1 py-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
        style={{ color: showTreemap ? "var(--kf-accent)" : "var(--kf-text-muted)" }}
        title={t("fileList.diskTreemap")}
      >
        <Icon name="donut_large" size={16} />
      </button>
      )}
      {/* 更新ボタン */}
      <button
        onClick={onRefresh}
        className="flex items-center px-1 py-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
        style={{ color: "var(--kf-text-muted)" }}
        title={t("fileList.refresh")}
      >
        <Icon name="refresh" size={16} />
      </button>
      {/* ペイン同期ナビトグル */}
      {!compact && (
      <button
        onClick={() => setSyncNavEnabled((v) => { localStorage.setItem("kf-sync-nav", v ? "0" : "1"); return !v; })}
        className="flex items-center px-1 py-0.5 rounded transition-opacity"
        style={{ color: syncNavEnabled ? "var(--kf-accent)" : "var(--kf-text-muted)", opacity: syncNavEnabled ? 1 : 0.5 }}
        title={syncNavEnabled ? t("fileList.syncNavOn") : t("fileList.syncNavOff")}
      >
        <Icon name="sync_alt" size={16} />
      </button>
      )}
    </>
  );
}
