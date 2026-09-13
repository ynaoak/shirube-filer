import { useTranslation } from "react-i18next";
import Icon from "../common/Icon";
import { formatModCombo } from "../../store/keybindingStore";

export type SearchMode = "local" | "recursive" | "content";

type Props = {
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searchActive: boolean;
  setSearchActive: (v: boolean) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  searchMode: SearchMode;
  onToggleSearchMode: () => void;
  recursiveLoading: boolean;
  grepLoading: boolean;
  onCancelSearch: () => void;
  onCancelGrep: () => void;
  onFocusList: () => void;
  /** 検索コントロールの右側に並べる追加要素（新規作成・表示切替などのツール群）。 */
  children?: React.ReactNode;
};

// 検索バー: 検索クエリ入力 + 検索モード切替（カレント/再帰/全文）+ 実行中のキャンセル。
// 右端には呼び出し側から渡されたツール群（children）を並べる。
export default function FileListSearchBar({
  searchInputRef, searchActive, setSearchActive, searchQuery, setSearchQuery,
  searchMode, onToggleSearchMode, recursiveLoading, grepLoading,
  onCancelSearch, onCancelGrep, onFocusList, children,
}: Props) {
  const { t } = useTranslation();
  // 検索語はディレクトリ移動やファイルクリックでも維持されるため、フォーカスが
  // 外れていても「絞り込み中」だと分かるように強調表示する。
  const highlighted = searchActive || searchQuery.length > 0;
  return (
    <div
      // min-w-0: フレックス列内で min-width:auto がコンテンツ幅まで膨らみ、
      // 狭いペインで右端のボタン群が見切れるのを防ぐ（入力欄側が縮む）
      className="flex items-center gap-1.5 px-2 py-1 border-b shrink-0 min-w-0"
      style={{
        backgroundColor: "var(--kf-bg-secondary)",
        borderColor: "var(--kf-border)",
      }}
    >
      <div
        className="flex items-center gap-1 flex-1 rounded px-2 min-w-0"
        style={{
          backgroundColor: "var(--kf-bg-primary)",
          border: `1px solid ${highlighted ? "var(--kf-accent)" : "var(--kf-border)"}`,
          transition: "border-color 0.15s",
        }}
      >
        <Icon
          name="search"
          size={12}
          style={{ color: highlighted ? "var(--kf-accent)" : "var(--kf-text-muted)", flexShrink: 0, transition: "color 0.15s" }}
        />
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => setSearchActive(true)}
          onBlur={() => setSearchActive(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearchQuery("");
              e.currentTarget.blur();
              onFocusList();
            }
          }}
          placeholder={t("fileList.searchPlaceholder", { key: formatModCombo("F") })}
          className="flex-1 bg-transparent outline-none text-xs py-0.5 min-w-0"
          style={{ color: "var(--kf-text-primary)", outline: "none" }}
        />
        {searchQuery && (
          <button
            onClick={() => { setSearchQuery(""); onFocusList(); }}
            className="flex items-center opacity-50 hover:opacity-100"
            style={{ color: "var(--kf-text-muted)" }}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
      <button
        onClick={onToggleSearchMode}
        className="flex items-center px-1 py-0.5 rounded transition-opacity"
        style={{
          color: searchMode !== "local" ? "var(--kf-accent)" : "var(--kf-text-muted)",
          opacity: searchMode !== "local" ? 1 : 0.5,
        }}
        title={searchMode === "local" ? t("fileList.switchRecursive") : searchMode === "recursive" ? t("fileList.switchContent") : t("fileList.switchCurrentOnly")}
      >
        <Icon name={searchMode === "content" ? "data_object" : searchMode === "recursive" ? "manage_search" : "search"} size={14} />
      </button>
      {(recursiveLoading || grepLoading) && (
        <button
          onClick={recursiveLoading ? onCancelSearch : onCancelGrep}
          className="flex items-center gap-0.5 px-1 py-0.5 rounded hover:opacity-80"
          style={{ color: "var(--kf-accent)" }}
          title={t("common.cancel")}
        >
          <Icon name="progress_activity" size={13} className="animate-spin" />
          <Icon name="close" size={11} />
        </button>
      )}
      {children}
    </div>
  );
}
