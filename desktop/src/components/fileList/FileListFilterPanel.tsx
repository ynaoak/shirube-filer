import { useTranslation } from "react-i18next";
import Icon from "../common/Icon";

type Props = {
  sizeMin: string;
  setSizeMin: (v: string) => void;
  sizeMax: string;
  setSizeMax: (v: string) => void;
  sizeUnit: "KB" | "MB";
  setSizeUnit: (v: "KB" | "MB") => void;
  dateMin: string;
  setDateMin: (v: string) => void;
  dateMax: string;
  setDateMax: (v: string) => void;
};

// 詳細フィルタ（サイズ範囲 / 日付範囲）パネル。表示の出し入れは呼び出し側で制御する。
export default function FileListFilterPanel({
  sizeMin, setSizeMin, sizeMax, setSizeMax, sizeUnit, setSizeUnit,
  dateMin, setDateMin, dateMax, setDateMax,
}: Props) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-nowrap items-center gap-x-3 px-2 py-1 border-b shrink-0 text-[10px] overflow-x-auto"
      style={{ backgroundColor: "var(--kf-bg-tertiary)", borderColor: "var(--kf-border)", color: "var(--kf-text-secondary)" }}
    >
      {/* サイズフィルタ */}
      <span style={{ color: "var(--kf-text-muted)" }}>{t("fileList.filterSizeLabel")}</span>
      <input
        type="number"
        min="0"
        placeholder={t("fileList.filterMinSize")}
        value={sizeMin}
        onChange={(e) => setSizeMin(e.target.value)}
        className="w-16 px-1 py-0.5 rounded border text-[10px]"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
      />
      <span style={{ color: "var(--kf-text-muted)" }}>{t("fileList.filterRange")}</span>
      <input
        type="number"
        min="0"
        placeholder={t("fileList.filterMaxSize")}
        value={sizeMax}
        onChange={(e) => setSizeMax(e.target.value)}
        className="w-16 px-1 py-0.5 rounded border text-[10px]"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
      />
      <select
        value={sizeUnit}
        onChange={(e) => setSizeUnit(e.target.value as "KB" | "MB")}
        className="px-1 py-0.5 rounded border text-[10px]"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
      >
        <option value="KB">KB</option>
        <option value="MB">MB</option>
      </select>

      {/* 日付フィルタ */}
      <span style={{ color: "var(--kf-text-muted)" }}>{t("fileList.filterDateLabel")}</span>
      <input
        type="date"
        value={dateMin}
        onChange={(e) => setDateMin(e.target.value)}
        className="px-1 py-0.5 rounded border text-[10px]"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
      />
      <span style={{ color: "var(--kf-text-muted)" }}>{t("fileList.filterRange")}</span>
      <input
        type="date"
        value={dateMax}
        onChange={(e) => setDateMax(e.target.value)}
        className="px-1 py-0.5 rounded border text-[10px]"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
      />

      <button
        onClick={() => { setSizeMin(""); setSizeMax(""); setDateMin(""); setDateMax(""); }}
        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors"
        style={{ color: "var(--kf-text-muted)" }}
        title={t("fileList.clearFilter")}
      >
        <Icon name="filter_list_off" size={11} />
        {t("common.clear")}
      </button>
    </div>
  );
}
