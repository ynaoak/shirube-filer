import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";

type CustomMenuItem = {
  id: string;
  label: string;
  icon: string;
  command: string;
  on: "all" | "file" | "dir";
};


function newItem(): CustomMenuItem {
  return { id: crypto.randomUUID(), label: "", icon: "open_in_new", command: "", on: "all" };
}

type Props = {
  onClose: () => void;
};

export default function ContextMenuEditor({ onClose }: Props) {
  const { t } = useTranslation();
  const dialogRef = useModal<HTMLDivElement>({ onClose });
  const ON_OPTIONS: { value: CustomMenuItem["on"]; label: string }[] = [
    { value: "all", label: t("contextMenuEditor.targetAll") },
    { value: "file", label: t("contextMenuEditor.targetFileOnly") },
    { value: "dir", label: t("contextMenuEditor.targetFolderOnly") },
  ];
  const [items, setItems] = useState<CustomMenuItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    invoke<CustomMenuItem[]>("load_context_menu_config")
      .then((data) => setItems(data))
      .catch(console.error);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await invoke("save_context_menu_config", { items });
      onClose();
    } catch (e) {
      console.error("[save_context_menu_config]", e);
    } finally {
      setSaving(false);
    }
  }, [items, onClose]);

  const addItem = () => {
    const item = newItem();
    setItems((prev) => [...prev, item]);
    setEditingId(item.id);
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    setItems((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveDown = (index: number) => {
    if (index >= items.length - 1) return;
    setItems((prev) => {
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  };

  const updateItem = (id: string, patch: Partial<CustomMenuItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  const editing = items.find((i) => i.id === editingId) ?? null;

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("contextMenuEditor.title", "右クリックメニューの編集")}
        className="kf-anim-scale rounded-lg shadow-xl flex overflow-hidden"
        style={{
          width: 640,
          maxHeight: "80vh",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        {/* Left: item list */}
        <div
          className="w-56 flex flex-col border-r text-xs shrink-0"
          style={{ borderColor: "var(--kf-border)" }}
        >
          <div
            className="flex items-center justify-between px-3 py-2 border-b font-semibold"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
          >
            <span>{t("contextMenuEditor.title")}</span>
            <button
              onClick={addItem}
              className="flex items-center gap-1 opacity-70 hover:opacity-100"
              title={t("contextMenuEditor.addItem")}
            >
              <Icon name="add" size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {items.length === 0 && (
              <div className="px-3 py-4 text-center" style={{ color: "var(--kf-text-muted)" }}>
                {t("contextMenuEditor.noItems")}
              </div>
            )}
            {items.map((item, index) => (
              <div
                key={item.id}
                className="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer group"
                style={{
                  backgroundColor: editingId === item.id ? "var(--kf-accent)" : undefined,
                  color: editingId === item.id ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-primary)",
                }}
                onClick={() => setEditingId(item.id)}
              >
                <Icon name={item.icon || "open_in_new"} size={14} />
                <span className="flex-1 truncate">{item.label || `(${t("contextMenuEditor.noLabel")})`}</span>
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); moveUp(index); }}
                    className="flex items-center"
                    title={t("contextMenuEditor.moveUp")}
                  >
                    <Icon name="arrow_upward" size={12} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); moveDown(index); }}
                    className="flex items-center"
                    title={t("contextMenuEditor.moveDown")}
                  >
                    <Icon name="arrow_downward" size={12} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                    className="flex items-center"
                    title={t("contextMenuEditor.delete")}
                    style={{ color: "var(--kf-error)" }}
                  >
                    <Icon name="delete" size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: editor */}
        <div className="flex-1 flex flex-col text-xs">
          <div
            className="flex items-center justify-between px-4 py-2 border-b font-semibold"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
          >
            <span>{t("contextMenuEditor.customize")}</span>
            <button aria-label={t("common.close")} onClick={onClose} className="opacity-50 hover:opacity-100 flex items-center">
              <Icon name="close" size={14} />
            </button>
          </div>

          {editing ? (
            <div className="flex-1 p-4 flex flex-col gap-3 overflow-y-auto">
              {/* Label */}
              <div className="flex flex-col gap-1">
                <label style={{ color: "var(--kf-text-muted)" }}>{t("contextMenuEditor.labelField")}</label>
                <input
                  className="rounded px-2 py-1 outline-none"
                  style={{
                    backgroundColor: "var(--kf-bg-secondary)",
                    border: "1px solid var(--kf-border)",
                    color: "var(--kf-text-primary)",
                  }}
                  value={editing.label}
                  onChange={(e) => updateItem(editing.id, { label: e.target.value })}
                  placeholder={t("contextMenuEditor.labelPlaceholder")}
                />
              </div>

              {/* Icon */}
              <div className="flex flex-col gap-1">
                <label style={{ color: "var(--kf-text-muted)" }}>
                  {t("contextMenuEditor.iconField")}（
                  <a
                    href="https://fonts.google.com/icons"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--kf-accent)" }}
                  >
                    Material Symbols
                  </a>
                  ）
                </label>
                <div className="flex items-center gap-2">
                  <Icon name={editing.icon || "open_in_new"} size={18} style={{ color: "var(--kf-accent)" }} />
                  <input
                    className="flex-1 rounded px-2 py-1 outline-none"
                    style={{
                      backgroundColor: "var(--kf-bg-secondary)",
                      border: "1px solid var(--kf-border)",
                      color: "var(--kf-text-primary)",
                    }}
                    value={editing.icon}
                    onChange={(e) => updateItem(editing.id, { icon: e.target.value })}
                    placeholder={t("contextMenuEditor.iconPlaceholder")}
                  />
                </div>
              </div>

              {/* Command */}
              <div className="flex flex-col gap-1">
                <label style={{ color: "var(--kf-text-muted)" }}>{t("contextMenuEditor.commandField")}</label>
                <input
                  className="rounded px-2 py-1 outline-none font-mono"
                  style={{
                    backgroundColor: "var(--kf-bg-secondary)",
                    border: "1px solid var(--kf-border)",
                    color: "var(--kf-text-primary)",
                  }}
                  value={editing.command}
                  onChange={(e) => updateItem(editing.id, { command: e.target.value })}
                  placeholder={t("contextMenuEditor.commandPlaceholder")}
                />
                <pre
                  className="mt-1 p-2 rounded text-[10px] whitespace-pre-wrap"
                  style={{
                    backgroundColor: "var(--kf-bg-secondary)",
                    color: "var(--kf-text-muted)",
                    border: "1px solid var(--kf-border-soft)",
                  }}
                >
                  {t("contextMenuEditor.placeholderHelp", { interpolation: { prefix: "[[", suffix: "]]" } })}
                </pre>
              </div>

              {/* On */}
              <div className="flex flex-col gap-1">
                <label style={{ color: "var(--kf-text-muted)" }}>{t("contextMenuEditor.showCondition")}</label>
                <div className="flex gap-3">
                  {ON_OPTIONS.map((opt) => (
                    <label key={opt.value} className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name={`on-${editing.id}`}
                        checked={editing.on === opt.value}
                        onChange={() => updateItem(editing.id, { on: opt.value })}
                        style={{ accentColor: "var(--kf-accent)" }}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div
              className="flex-1 flex flex-col items-center justify-center gap-2"
              style={{ color: "var(--kf-text-muted)" }}
            >
              <Icon name="menu" size={32} />
              <span>{t("contextMenuEditor.selectItemHint")}</span>
              <button
                onClick={addItem}
                className="mt-2 flex items-center gap-1 px-3 py-1 rounded text-xs"
                style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
              >
                <Icon name="add" size={14} />
                {t("contextMenuEditor.addItem")}
              </button>
            </div>
          )}

          {/* Footer */}
          <div
            className="flex items-center justify-end gap-2 px-4 py-2 border-t"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
          >
            <button
              onClick={onClose}
              className="px-3 py-1 rounded text-xs opacity-70 hover:opacity-100"
              style={{ border: "1px solid var(--kf-border)" }}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1 rounded text-xs font-semibold disabled:opacity-40"
              style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
            >
              {saving ? t("contextMenuEditor.saving") : t("contextMenuEditor.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
