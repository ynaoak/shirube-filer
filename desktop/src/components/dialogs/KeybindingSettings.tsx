import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useKeybindings } from "../../store/keybindingStore";
import { KeyDescriptor, KeyBinding, ShortcutAction } from "../../types/keybinding";
import Icon from "../common/Icon";

const ACTION_DESCRIPTION_MAP: Record<string, string> = {
  "上のアイテムを選択": "keybindings.selectPrev",
  "下のアイテムを選択": "keybindings.selectNext",
  "ファイル/フォルダを開く": "keybindings.openItem",
  "親ディレクトリへ移動": "keybindings.goParent",
  "リネーム": "keybindings.rename",
  "削除（ゴミ箱）": "keybindings.deleteToTrash",
  "更新": "keybindings.refresh",
  "プロパティ": "keybindings.properties",
  "パスをコピー": "keybindings.copyPath",
  "エクスプローラーで開く": "keybindings.openInExplorer",
  "コピー": "keybindings.copy",
  "カット": "keybindings.cut",
  "ペースト": "keybindings.paste",
  "検索を開く": "keybindings.openSearch",
  "新しいタブ": "keybindings.newTab",
  "タブを閉じる": "keybindings.closeTab",
};

type Props = { onClose: () => void; embedded?: boolean };

function keyLabel(k: KeyDescriptor): string {
  const parts: string[] = [];
  if (k.ctrl)  parts.push("Ctrl");
  if (k.meta)  parts.push("⌘");
  if (k.shift) parts.push("Shift");
  if (k.alt)   parts.push("Alt");
  parts.push(k.key.length === 1 ? k.key.toUpperCase() : k.key);
  return parts.join("+");
}

/** Returns a map of "normalized key string" → actions that use it */
function buildConflictMap(bindings: KeyBinding[]): Map<string, ShortcutAction[]> {
  const map = new Map<string, ShortcutAction[]>();
  for (const b of bindings) {
    for (const k of b.keys) {
      const label = keyLabel(k);
      const existing = map.get(label) ?? [];
      if (!existing.includes(b.action)) existing.push(b.action);
      map.set(label, existing);
    }
  }
  return map;
}

function isConflicted(binding: KeyBinding, conflictMap: Map<string, ShortcutAction[]>): boolean {
  return binding.keys.some((k) => (conflictMap.get(keyLabel(k))?.length ?? 0) > 1);
}

export default function KeybindingSettings({ onClose, embedded }: Props) {
  const { t } = useTranslation();
  const { bindings, updateBinding, resetBindings, saveToFile } = useKeybindings();
  const [editing, setEditing] = useState<ShortcutAction | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const conflictMap = buildConflictMap(bindings);

  const handleKeyCapture = (action: ShortcutAction, e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Ignore modifier-only keypresses
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    // Escape cancels editing without registering a binding
    if (e.key === "Escape") { setEditing(null); return; }
    const desc: KeyDescriptor = {
      key: e.key,
      ctrl: e.ctrlKey || undefined,
      shift: e.shiftKey || undefined,
      alt: e.altKey || undefined,
      meta: e.metaKey || undefined,
    };
    updateBinding(action, [desc]);
    setEditing(null);
  };

  const handleSave = async () => {
    await saveToFile();
    setStatus(t("keybindings.saved"));
    setTimeout(() => setStatus(null), 2000);
  };

  const handleReset = () => {
    resetBindings();
    setStatus(t("keybindings.resetToDefault"));
    setTimeout(() => setStatus(null), 2000);
  };

  const conflictCount = bindings.filter((b) => isConflicted(b, conflictMap)).length;

  const inner = (
    <div
      className={embedded ? "flex flex-col text-xs h-full" : "kf-anim-scale rounded-lg shadow-xl flex flex-col text-xs"}
      style={embedded ? { color: "var(--kf-text-primary)" } : {
        width: 520,
        maxHeight: "80vh",
        backgroundColor: "var(--kf-bg-primary)",
        border: "1px solid var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {!embedded && (
        <div
          className="flex items-center justify-between px-4 py-2 border-b font-semibold"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <span>{t("keybindings.title")}</span>
          <button aria-label={t("common.close")} onClick={onClose} className="opacity-50 hover:opacity-100">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

        {/* Conflict warning */}
        {conflictCount > 0 && (
          <div
            className="px-4 py-2 flex items-center gap-2 border-b"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "#7f1d1d22", color: "var(--kf-error)" }}
          >
            <Icon name="warning" size={14} />
            <span>{t("keybindings.conflictWarning", { count: conflictCount })}</span>
          </div>
        )}

        {/* Bindings list */}
        <div className="flex-1 overflow-y-auto">
          {/* Column header */}
          <div
            className="grid px-4 py-1 font-semibold sticky top-0"
            style={{
              gridTemplateColumns: "1fr 160px 24px",
              backgroundColor: "var(--kf-bg-secondary)",
              borderBottom: "1px solid var(--kf-border)",
              color: "var(--kf-text-muted)",
            }}
          >
            <span>{t("keybindings.colAction")}</span>
            <span>{t("keybindings.colKey")}</span>
            <span></span>
          </div>

          {bindings.map((b) => {
            const conflicted = isConflicted(b, conflictMap);
            const isEditingThis = editing === b.action;
            return (
              <div
                key={b.action}
                className="grid items-center px-4 py-1.5 border-b"
                style={{
                  gridTemplateColumns: "1fr 160px 24px",
                  borderColor: "var(--kf-border-soft)",
                  backgroundColor: conflicted ? "#7f1d1d18" : undefined,
                }}
              >
                {/* Description */}
                <div className="flex items-center gap-1.5">
                  {conflicted && <Icon name="warning" size={12} style={{ color: "var(--kf-error)" }} />}
                  <span style={{ color: conflicted ? "var(--kf-error)" : "var(--kf-text-primary)" }}>
                    {t(ACTION_DESCRIPTION_MAP[b.description] ?? b.description)}
                  </span>
                </div>

                {/* Key display / capture input */}
                {isEditingThis ? (
                  <div
                    className="rounded px-2 py-0.5 text-center font-mono"
                    style={{
                      border: "1px solid var(--kf-accent)",
                      backgroundColor: "var(--kf-bg-secondary)",
                      color: "var(--kf-accent)",
                      outline: "none",
                    }}
                    tabIndex={0}
                    autoFocus
                    onKeyDown={(e) => handleKeyCapture(b.action, e)}
                    onBlur={() => setEditing(null)}
                  >
                    {t("keybindings.pressKey")}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {b.keys.map((k, i) => (
                      <span
                        key={i}
                        className="px-1.5 py-0.5 rounded font-mono"
                        style={{
                          backgroundColor: "var(--kf-bg-tertiary)",
                          border: `1px solid ${conflicted ? "var(--kf-error)" : "var(--kf-border)"}`,
                          color: conflicted ? "var(--kf-error)" : "var(--kf-text-secondary)",
                        }}
                      >
                        {keyLabel(k)}
                      </span>
                    ))}
                    {b.keys.length === 0 && (
                      <span style={{ color: "var(--kf-text-muted)" }}>{t("keybindings.notSet")}</span>
                    )}
                  </div>
                )}

                {/* Edit button */}
                <button
                  onClick={() => setEditing(isEditingThis ? null : b.action)}
                  className="flex items-center justify-center opacity-40 hover:opacity-100"
                  title={t("keybindings.changeKey")}
                >
                  <Icon name="edit" size={13} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-2 border-t gap-2"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <button
            onClick={handleReset}
            className="px-3 py-1 rounded opacity-70 hover:opacity-100 text-xs"
            style={{ border: "1px solid var(--kf-border)" }}
          >
            {t("keybindings.resetButton")}
          </button>
          <div className="flex items-center gap-2">
            {status && <span style={{ color: "var(--kf-text-muted)" }}>{status}</span>}
            <button
              onClick={onClose}
              className="px-3 py-1 rounded opacity-70 hover:opacity-100 text-xs"
              style={{ border: "1px solid var(--kf-border)" }}
            >
              {t("common.close")}
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1 rounded font-semibold text-xs"
              style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
            >
              {t("common.save")}
            </button>
          </div>
      </div>
    </div>
  );

  if (embedded) return inner;
  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {inner}
    </div>
  );
}
