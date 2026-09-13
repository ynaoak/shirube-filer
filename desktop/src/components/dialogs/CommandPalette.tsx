import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";

export type PaletteCommand = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  action: () => void;
};

type Props = {
  commands: PaletteCommand[];
  onClose: () => void;
};

export default function CommandPalette({ commands, onClose }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 入力欄は自前でフォーカス、Esc も自前で処理するので hook 側は無効化。
  // フォーカストラップとフォーカス復帰・aria のみ委譲する。
  const dialogRef = useModal<HTMLDivElement>({ onClose, closeOnEsc: false, autoFocus: false });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.description?.toLowerCase().includes(q) ?? false)
    );
  }, [query, commands]);

  // Reset index when query changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) {
        cmd.action();
        onClose();
      }
    }
  };

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-start justify-center pt-20"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("commandPalette.title", "コマンドパレット")}
        className="kf-anim-pop rounded-lg shadow-2xl flex flex-col overflow-hidden"
        style={{
          width: 560,
          maxHeight: "60vh",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-2 px-3 py-2 border-b"
          style={{ borderColor: "var(--kf-border)" }}
        >
          <Icon name="search" size={16} style={{ color: "var(--kf-text-muted)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("commandPalette.searchPlaceholder")}
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: "var(--kf-text-primary)" }}
          />
          <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>{t("commandPalette.escHint")}</span>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs" style={{ color: "var(--kf-text-muted)" }}>
              {t("commandPalette.noMatch")}
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                className="flex items-center gap-3 px-3 py-2 cursor-pointer"
                style={{
                  backgroundColor:
                    i === activeIndex ? "var(--kf-bg-secondary)" : undefined,
                  borderBottom: "1px solid var(--kf-border-soft)",
                }}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={() => { cmd.action(); onClose(); }}
              >
                <span style={{ color: "var(--kf-accent)", flexShrink: 0 }}>
                  <Icon name={cmd.icon ?? "chevron_right"} size={16} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium" style={{ color: "var(--kf-text-primary)" }}>
                    {cmd.label}
                  </div>
                  {cmd.description && (
                    <div className="text-xs truncate" style={{ color: "var(--kf-text-muted)" }}>
                      {cmd.description}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          className="flex items-center gap-3 px-3 py-1.5 border-t text-xs"
          style={{ borderColor: "var(--kf-border)", color: "var(--kf-text-muted)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <span><kbd className="font-mono">↑↓</kbd> {t("commandPalette.hintMove")}</span>
          <span><kbd className="font-mono">Enter</kbd> {t("commandPalette.hintExecute")}</span>
          <span><kbd className="font-mono">Esc</kbd> {t("commandPalette.hintClose")}</span>
        </div>
      </div>
    </div>
  );
}
