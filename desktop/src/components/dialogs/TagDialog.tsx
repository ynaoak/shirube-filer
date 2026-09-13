import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";
import { useTags } from "../../store/tagStore";

type Props = {
  /** タグを付け外しする対象。右クリック時の選択（複数可）。 */
  paths: string[];
  onClose: () => void;
};

/** 選択に対するタグの状態。all = 全部に付いている、some = 一部だけ。 */
type TagState = "all" | "some" | "none";

/**
 * 右クリックメニューから開くタグ編集ダイアログ。
 *
 * 複数選択に対応する。カラーラベルの色見本と同じ考え方で、
 * 「全部に付いていれば ON」とみなし、押すと全部から外す / 全部に付ける。
 * 一部にだけ付いているタグは中間状態として区別できるようにする
 * （そのまま押すと全部に付ける）。
 */
export default function TagDialog({ paths, onClose }: Props) {
  const { t } = useTranslation();
  const { getTags, addTag, removeTag, allTags } = useTags();
  const [draft, setDraft] = useState("");
  const dialogRef = useModal<HTMLDivElement>({ onClose });

  const stateOf = useMemo(() => {
    const map = new Map<string, TagState>();
    const counts = new Map<string, number>();
    for (const p of paths) {
      for (const tag of getTags(p)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    for (const [tag, n] of counts) map.set(tag, n === paths.length ? "all" : "some");
    return map;
  }, [paths, getTags]);

  // 既存タグ（他のファイルに付いているものも含む）＋選択に付いているタグ。
  const candidates = useMemo(() => {
    const names = new Set<string>(allTags.map((x) => x.tag));
    for (const tag of stateOf.keys()) names.add(tag);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [allTags, stateOf]);

  const toggle = (tag: string) => {
    // 全部に付いているときだけ外す。一部・未付与はまとめて付ける。
    if (stateOf.get(tag) === "all") {
      for (const p of paths) removeTag(p, tag);
    } else {
      for (const p of paths) addTag(p, tag);
    }
  };

  const commitDraft = () => {
    const v = draft.trim();
    if (!v) return;
    for (const p of paths) addTag(p, v);
    setDraft("");
  };

  const targetLabel =
    paths.length === 1
      ? paths[0].split(/[\\/]/).pop() ?? paths[0]
      : t("tagDialog.multipleTargets", { count: paths.length });

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("tagDialog.title")}
        className="kf-anim-scale rounded-lg shadow-xl flex flex-col text-xs overflow-hidden"
        style={{
          width: 380,
          maxHeight: "70vh",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b font-semibold"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <Icon name="sell" size={14} style={{ color: "var(--kf-text-muted)" }} />
          <span className="flex-1 truncate">{t("tagDialog.title")}</span>
          <span className="truncate font-normal" style={{ color: "var(--kf-text-muted)", maxWidth: 160 }}>
            {targetLabel}
          </span>
        </div>

        {/* 新しいタグを追加 */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b" style={{ borderColor: "var(--kf-border)" }}>
          <Icon name="add" size={13} style={{ color: "var(--kf-text-muted)", flexShrink: 0 }} />
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitDraft(); }
            }}
            placeholder={t("tagDialog.newTagPlaceholder")}
            className="flex-1 px-2 py-1 rounded outline-none min-w-0"
            style={{
              backgroundColor: "var(--kf-bg-secondary)",
              border: "1px solid var(--kf-border)",
              color: "var(--kf-text-primary)",
            }}
          />
          <button
            onClick={commitDraft}
            disabled={!draft.trim()}
            className="px-2 py-1 rounded shrink-0 disabled:opacity-40"
            style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
          >
            {t("tagDialog.add")}
          </button>
        </div>

        {/* 既存タグの一覧 */}
        <div className="flex-1 overflow-y-auto py-1">
          {candidates.length === 0 ? (
            <div className="px-4 py-4 text-center" style={{ color: "var(--kf-text-muted)" }}>
              {t("tagDialog.noTags")}
            </div>
          ) : (
            candidates.map((tag) => {
              const state = stateOf.get(tag) ?? "none";
              return (
                <button
                  key={tag}
                  role="menuitemcheckbox"
                  aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
                  onClick={() => toggle(tag)}
                  className="w-full flex items-center gap-2 px-4 py-1.5 text-left transition-colors"
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = ""; }}
                >
                  <Icon
                    name={state === "all" ? "check_box" : state === "some" ? "indeterminate_check_box" : "check_box_outline_blank"}
                    size={14}
                    style={{ color: state === "none" ? "var(--kf-text-muted)" : "var(--kf-accent)", flexShrink: 0 }}
                  />
                  <span className="flex-1 truncate">{tag}</span>
                  {state === "some" && (
                    <span style={{ fontSize: 10, color: "var(--kf-text-muted)" }}>
                      {t("tagDialog.partial")}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-4 py-2 border-t"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <button
            onClick={onClose}
            className="px-3 py-1 rounded"
            style={{ backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-primary)" }}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
