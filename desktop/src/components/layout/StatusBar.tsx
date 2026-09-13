import { useTranslation } from "react-i18next";
import { useStatus } from "../../store/statusStore";
import Icon from "../common/Icon";

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function StatusBar() {
  const { t } = useTranslation();
  const { status } = useStatus();
  const {
    selectedCount, totalCount, folderCount, fileCount, selectedSize,
    clipboard, error,
    unfilteredCount, hiddenCount, isFiltered,
    viewMode, sortKey, sortDir,
  } = status;

  return (
    <div
      className="flex items-center gap-3 px-3 py-1 text-xs shrink-0 border-t"
      style={{
        backgroundColor: "var(--kf-bg-secondary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-muted)",
      }}
    >
      {/* スクリーンリーダー向け: 選択件数の変化をアナウンス（視覚的には非表示） */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {selectedCount > 0
          ? `${t("statusBar.selectedCount", { count: selectedCount })}${selectedSize > 0 ? ` ${t("statusBar.totalSize", { size: formatSize(selectedSize) })}` : ""}`
          : ""}
      </span>

      {/* Item counts: prioritize selection > breakdown > total */}
      <span className="flex items-center gap-2">
        {selectedCount > 0 && (
          <span style={{ color: "var(--kf-accent)" }}>
            {t("statusBar.selectedCount", { count: selectedCount })}
          </span>
        )}
        {folderCount > 0 && (
          <span className="flex items-center gap-0.5" title={t("fileList.typeFolder")}>
            <Icon name="folder" size={11} />
            {folderCount}
          </span>
        )}
        {fileCount > 0 && (
          <span className="flex items-center gap-0.5" title={t("fileList.typeFile")}>
            <Icon name="description" size={11} />
            {fileCount}
          </span>
        )}
        {folderCount === 0 && fileCount === 0 && (
          <span>{t("statusBar.itemCount", { count: totalCount })}</span>
        )}
      </span>

      {/* Filtered indicator: shows "(N件中)" when narrowing */}
      {isFiltered && unfilteredCount > totalCount && (
        <span
          className="flex items-center gap-1"
          title={t("statusBar.filteredHidden", { count: unfilteredCount - totalCount })}
        >
          <Icon name="filter_alt" size={11} style={{ color: "var(--kf-accent)" }} />
          <span>
            {totalCount} / {unfilteredCount}
          </span>
        </span>
      )}

      {/* Hidden files hint */}
      {hiddenCount > 0 && (
        <span
          className="flex items-center gap-1"
          title={t("statusBar.hiddenFiles", { count: hiddenCount })}
          style={{ opacity: 0.7 }}
        >
          <Icon name="visibility_off" size={11} />
          {hiddenCount}
        </span>
      )}

      {/* Selected size */}
      {selectedCount > 0 && selectedSize > 0 && (
        <span style={{ color: "var(--kf-text-secondary)" }}>
          {formatSize(selectedSize)}
        </span>
      )}

      <div className="flex-1" />

      {/* Transient error message (undo/redo failures etc.) */}
      {error && (
        <span className="flex items-center gap-1" style={{ color: "var(--kf-error)" }}>
          <Icon name="error" size={12} />
          {error}
        </span>
      )}

      {/* Clipboard state */}
      {clipboard && (
        <span
          className="flex items-center gap-1"
          title={t("statusBar.clipboard", {
            count: clipboard.count,
            mode: clipboard.mode === "copy" ? t("common.copy") : t("common.cut"),
          })}
        >
          <Icon name={clipboard.mode === "copy" ? "content_copy" : "content_cut"} size={12} />
          <span>{t("statusBar.itemCount", { count: clipboard.count })}</span>
        </span>
      )}

      {/* Sort indicator（ソートキーは生の値ではなく列名として表示する） */}
      {sortKey && sortDir && (() => {
        const sortKeyLabels: Record<string, string> = {
          name: t("fileList.colName"),
          size: t("fileList.colSize"),
          modified: t("fileList.colDate"),
          ext: t("fileList.colExt"),
          type: t("fileList.colType"),
        };
        const keyLabel = sortKeyLabels[sortKey] ?? sortKey;
        const dirLabel = sortDir === "asc" ? t("statusBar.sortAsc") : t("statusBar.sortDesc");
        return (
          <span
            className="flex items-center gap-0.5"
            title={t("statusBar.sortOrder", { key: keyLabel, dir: dirLabel })}
            style={{ opacity: 0.7 }}
          >
            <Icon name={sortDir === "asc" ? "arrow_upward" : "arrow_downward"} size={11} />
            <span>{keyLabel}</span>
          </span>
        );
      })()}

      {/* View mode indicator */}
      {viewMode && (
        <Icon
          name={viewMode === "grid" ? "grid_view" : viewMode === "compact" ? "view_headline" : "view_list"}
          size={12}
          title={t(
            viewMode === "grid"
              ? "statusBar.gridView"
              : viewMode === "compact"
                ? "statusBar.compactView"
                : "statusBar.listView"
          )}
          style={{ opacity: 0.7 }}
        />
      )}
    </div>
  );
}
