import { SortKey, SortDir } from "../../types/fileListTypes";
import Icon from "../common/Icon";

// ソート対象列に表示する昇順/降順アイコン。
export default function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return null;
  return (
    <Icon
      name={sortDir === "asc" ? "arrow_upward" : "arrow_downward"}
      size={11}
      style={{ color: "var(--kf-accent)" }}
    />
  );
}
