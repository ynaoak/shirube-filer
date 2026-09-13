import { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../common/Icon";
import { useTags } from "../../store/tagStore";

type Props = {
  /** パネル右上の × から閉じる（ActivityBar のトグルと同じ導線） */
  onClose?: () => void;
  /** The file currently focused in the preview, to attach tags to. */
  activeFilePath: string | null;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
};

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

export default function TagSearchPanel({ activeFilePath, onNavigate, onOpenFile, onClose }: Props) {
  const { t } = useTranslation();
  const { tags, getTags, addTag, removeTag, allTags } = useTags();
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const activeTags = activeFilePath ? getTags(activeFilePath) : [];

  const commitTag = useCallback(() => {
    if (!activeFilePath) return;
    const v = draft.trim();
    if (!v) return;
    addTag(activeFilePath, v);
    setDraft("");
  }, [activeFilePath, draft, addTag]);

  const toggleFilter = useCallback((tag: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  // Files matching ALL selected tags (AND).
  const matches = useMemo(() => {
    if (selected.size === 0) return [];
    const sel = Array.from(selected);
    return Object.entries(tags)
      .filter(([, list]) => sel.every((t) => list.includes(t)))
      .map(([path]) => path)
      .sort((a, b) => baseName(a).localeCompare(baseName(b)));
  }, [tags, selected]);

  return (
    <div
      className="w-72 flex-shrink-0 flex flex-col border-l text-xs overflow-hidden"
      style={{
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="sell" size={14} style={{ color: "var(--kf-text-muted)" }} />
        <span className="font-semibold flex-1">{t("tagPanel.title")}</span>
        {onClose && (
          <button
            onClick={onClose}
            className="flex items-center opacity-50 hover:opacity-100 transition-opacity"
            title={t("common.close")}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      {/* Tag the active file */}
      <div
        className="px-3 py-2 border-b shrink-0"
        style={{ borderColor: "var(--kf-border-soft)" }}
      >
        {activeFilePath ? (
          <>
            <div className="truncate mb-1.5" style={{ color: "var(--kf-text-muted)", fontSize: 10 }} title={activeFilePath}>
              {baseName(activeFilePath)}
            </div>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {activeTags.length === 0 && (
                <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>{t("tagPanel.noTags")}</span>
              )}
              {activeTags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--kf-accent) 18%, transparent)",
                    color: "var(--kf-text-primary)",
                  }}
                >
                  {tag}
                  <button
                    onClick={() => removeTag(activeFilePath, tag)}
                    className="flex items-center opacity-60 hover:opacity-100"
                    title={t("tagPanel.delete")}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <input
                list="tag-autocomplete"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitTag(); } }}
                placeholder={t("tagPanel.addPlaceholder")}
                className="flex-1 bg-transparent outline-none rounded px-1.5 py-0.5"
                style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
              />
              <datalist id="tag-autocomplete">
                {allTags.map(({ tag }) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
              <button
                onClick={commitTag}
                className="flex items-center px-1.5 py-0.5 rounded"
                style={{ color: "var(--kf-accent)" }}
                title={t("tagPanel.add")}
              >
                <Icon name="add" size={14} />
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-1.5" style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>
            <Icon name="info" size={12} />
            <span>{t("tagPanel.selectFileHint")}</span>
          </div>
        )}
      </div>

      {/* All tags (filter chips) */}
      <div
        className="px-3 py-2 border-b shrink-0"
        style={{ borderColor: "var(--kf-border-soft)" }}
      >
        <div className="flex items-center justify-between mb-1.5">
          <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>{t("tagPanel.allTags")}</span>
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="hover:opacity-80"
              style={{ color: "var(--kf-accent)", fontSize: 10 }}
            >
              {t("tagPanel.clear")}
            </button>
          )}
        </div>
        {allTags.length === 0 ? (
          <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>{t("tagPanel.noTagsYet")}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {allTags.map(({ tag, count }) => {
              const active = selected.has(tag);
              return (
                <button
                  key={tag}
                  onClick={() => toggleFilter(tag)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: active
                      ? "var(--kf-accent)"
                      : "var(--kf-bg-secondary)",
                    color: active ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-secondary)",
                    border: "1px solid var(--kf-border)",
                  }}
                >
                  {tag}
                  <span style={{ opacity: 0.7, fontSize: 9 }}>{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Matching files */}
      <div className="flex-1 overflow-y-auto">
        {selected.size === 0 ? (
          <div className="flex flex-col items-center justify-center h-20 gap-1" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="sell" size={20} />
            <span>{t("tagPanel.filterByTag")}</span>
          </div>
        ) : matches.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-20 gap-1" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="search_off" size={20} />
            <span>{t("tagPanel.noMatch")}</span>
          </div>
        ) : (
          matches.map((path) => (
            <div
              key={path}
              className="flex items-center gap-2 px-3 py-1 cursor-pointer"
              style={{ borderBottom: "1px solid var(--kf-border-soft)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
              onClick={() => { onNavigate(parentDir(path)); onOpenFile(path); }}
              title={path}
            >
              <Icon name="description" size={13} style={{ flexShrink: 0, color: "var(--kf-text-muted)" }} />
              <div className="flex flex-col min-w-0 flex-1">
                <span className="truncate">{baseName(path)}</span>
                <span className="truncate font-mono" style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>
                  {parentDir(path)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
