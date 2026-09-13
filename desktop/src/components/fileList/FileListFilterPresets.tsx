import { useTranslation } from "react-i18next";
import { FilterPreset } from "../../types/fileListTypes";
import Icon from "../common/Icon";
import { COLOR_LABEL_COLORS, COLOR_LABEL_NAMES } from "../../hooks/useFileFilter";

type Props = {
  filterPreset: FilterPreset;
  onSelectPreset: (p: FilterPreset) => void;
  /** 選択中のカラーラベル（hex）。null = 絞り込みなし。 */
  labelFilter: string | null;
  onSelectLabel: (color: string | null) => void;
  /** 現在のフォルダで実際に使われているラベル色（使っていない色は出さない）。 */
  availableLabels: string[];
  /** 狭いペインではラベルを畳んでアイコンだけにする（文字が途中で切れるのを防ぐ）。 */
  iconOnly?: boolean;
  showAdvFilter: boolean;
  onToggleAdvFilter: () => void;
  advFilterDirty: boolean;
};

// 種別フィルタのプリセット（全て/フォルダ/画像/コード/テキスト/圧縮/Office）と
// 詳細フィルタ（サイズ・日付）パネルの開閉トグル。
export default function FileListFilterPresets({
  filterPreset, onSelectPreset, labelFilter, onSelectLabel, availableLabels,
  iconOnly = false, showAdvFilter, onToggleAdvFilter, advFilterDirty,
}: Props) {
  const { t } = useTranslation();
  return (
    // チップ列だけを横スクロール領域にし、詳細フィルタボタンは右端に常時表示する
    // （以前はボタンまでスクロール領域内にあり、狭いペインで到達不能だった）
    <div
      className="flex flex-nowrap items-center gap-0.5 px-2 py-1 border-b shrink-0 min-w-0"
      style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
    >
    <div
      className="flex flex-nowrap items-center gap-0.5 flex-1 min-w-0 overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
      // 縦ホイールで横スクロールできるように（チップ行に横スクロールバーは出さない）
      onWheel={(e) => {
        const el = e.currentTarget;
        if (el.scrollWidth > el.clientWidth && e.deltaY !== 0) {
          el.scrollLeft += e.deltaY;
        }
      }}
    >
      {(["all", "folders", "images", "code", "text", "archives", "microsoft"] as FilterPreset[]).map((p) => {
        const labels: Record<FilterPreset, string> = { all: t("fileList.filterAll"), folders: t("fileList.filterFolder"), images: t("fileList.filterImage"), code: t("fileList.filterCode"), text: t("fileList.filterText"), archives: t("fileList.filterZip"), microsoft: t("fileList.filterMicrosoft") };
        const icons: Record<FilterPreset, string> = { all: "filter_list_off", folders: "folder", images: "image", code: "code", text: "description", archives: "folder_zip", microsoft: "grid_view" };
        const active = filterPreset === p;
        return (
          <button
            key={p}
            onClick={() => onSelectPreset(p)}
            title={labels[p]}
            aria-label={labels[p]}
            className={`flex items-center gap-1 py-[3px] rounded-full text-[11px] shrink-0 transition-colors ${iconOnly ? "px-1.5" : "px-2"}`}
            style={{
              backgroundColor: active ? "var(--kf-accent)" : "transparent",
              color: active ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-muted)",
              border: active ? "1px solid transparent" : "1px solid var(--kf-border-soft)",
            }}
            onMouseEnter={(e) => {
              if (active) return;
              const el = e.currentTarget as HTMLButtonElement;
              el.style.backgroundColor = "var(--kf-bg-tertiary)";
              el.style.color = "var(--kf-text-secondary)";
            }}
            onMouseLeave={(e) => {
              if (active) return;
              const el = e.currentTarget as HTMLButtonElement;
              el.style.backgroundColor = "transparent";
              el.style.color = "var(--kf-text-muted)";
            }}
          >
            <Icon name={icons[p]} size={11} />
            {!iconOnly && labels[p]}
          </button>
        );
      })}

      {/* カラーラベルの絞り込み。現在のフォルダで使われている色だけを丸で並べる
          （どの色が実際に付いているか一目で分かり、空振りの絞り込みも防げる）。
          同じ色をもう一度押すと解除。 */}
      {availableLabels.length > 0 && (
        <>
          <div
            className="shrink-0 self-stretch my-1 mx-1"
            style={{ width: 1, backgroundColor: "var(--kf-border)" }}
          />
          {COLOR_LABEL_COLORS.filter((c) => availableLabels.includes(c)).map((color) => {
            const idx = COLOR_LABEL_COLORS.indexOf(color);
            const active = labelFilter === color;
            return (
              <button
                key={color}
                onClick={() => onSelectLabel(active ? null : color)}
                title={t("fileList.filterByLabel", { label: t(COLOR_LABEL_NAMES[idx]) })}
                aria-pressed={active}
                data-label-color={color}
                className="flex items-center justify-center rounded-full shrink-0 transition-colors"
                style={{
                  width: 20,
                  height: 20,
                  // 選択中はアクセント色のリングで囲む（drop ターゲットと同じ発想で、
                  // 「色そのもの」と「選択されているか」を別の手段で表す）。
                  border: active ? "2px solid var(--kf-accent)" : "1px solid var(--kf-border-soft)",
                  backgroundColor: "transparent",
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    backgroundColor: color,
                    display: "block",
                  }}
                />
              </button>
            );
          })}
        </>
      )}
      </div>
      <button
        onClick={onToggleAdvFilter}
        className="flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] shrink-0 transition-colors"
        title={t("fileList.filterSizeDateButton")}
        style={{
          backgroundColor: showAdvFilter || advFilterDirty ? "var(--kf-accent)" : "transparent",
          color: showAdvFilter || advFilterDirty ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-muted)",
          border: showAdvFilter || advFilterDirty ? "1px solid transparent" : "1px solid var(--kf-border-soft)",
        }}
        onMouseEnter={(e) => {
          if (showAdvFilter || advFilterDirty) return;
          const el = e.currentTarget as HTMLButtonElement;
          el.style.backgroundColor = "var(--kf-bg-tertiary)";
          el.style.color = "var(--kf-text-secondary)";
        }}
        onMouseLeave={(e) => {
          if (showAdvFilter || advFilterDirty) return;
          const el = e.currentTarget as HTMLButtonElement;
          el.style.backgroundColor = "transparent";
          el.style.color = "var(--kf-text-muted)";
        }}
      >
        <Icon name="tune" size={11} />
      </button>
    </div>
  );
}
