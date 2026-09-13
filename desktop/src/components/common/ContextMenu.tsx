import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";

type MenuItem =
  | {
      type: "item";
      label: string;
      icon: string;
      iconColor?: string;
      action: () => void;
      disabled?: boolean;
      /** 右端に薄く表示するキーボードショートカットのヒント（例: "Ctrl+C"） */
      shortcut?: string;
      /** 既定アクション（ダブルクリック相当）を太字で強調する */
      emphasis?: boolean;
    }
  | { type: "separator" }
  /** セクション見出し（薄い小さなラベル行） */
  | { type: "label"; label: string }
  /** カラーラベルなどの色見本を 1 行に横並びで出すスウォッチ行 */
  | {
      type: "colorRow";
      colors: { color: string; label: string; selected?: boolean; action: () => void }[];
    };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Use capture so we get the event before it bubbles to other handlers
    document.addEventListener("mousedown", handle, true);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("mousedown", handle, true);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [onClose]);

  // 位置調整: まず概算で初期位置を決め、マウント後に実サイズで再クランプする。
  // メニューがウィンドウより高い場合は maxHeight + スクロールで収める
  // （カスタム描画メニューは OS メニューと違いウィンドウ外に出られないため）。
  const menuWidth = 200;
  const itemCount = items.filter((i) => i.type === "item").length;
  const separatorCount = items.filter((i) => i.type === "separator").length;
  const colorRowCount = items.filter((i) => i.type === "colorRow").length;
  const labelCount = items.filter((i) => i.type === "label").length;
  const menuHeight = itemCount * 28 + separatorCount * 9 + colorRowCount * 28 + labelCount * 20 + 8;
  const [pos, setPos] = useState(() => {
    const adjustedX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
    let adjustedY = y + menuHeight > window.innerHeight ? y - menuHeight : y;
    adjustedY = Math.max(4, adjustedY);
    return { x: adjustedX, y: adjustedY };
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos((prev) => {
      const nx = Math.max(4, Math.min(prev.x, window.innerWidth - w - 4));
      const ny = Math.max(4, Math.min(prev.y, window.innerHeight - h - 4));
      return nx !== prev.x || ny !== prev.y ? { x: nx, y: ny } : prev;
    });
  }, [items.length]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-orientation="vertical"
      className="kf-surface-menu fixed z-50 py-1 text-xs"
      style={{
        left: pos.x,
        top: pos.y,
        minWidth: menuWidth,
        maxHeight: window.innerHeight - 8,
        overflowY: "auto",
        color: "var(--kf-text-primary)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.type === "separator") {
          return (
            <div
              key={i}
              role="separator"
              className="my-1 mx-2"
              style={{ borderTop: "1px solid var(--kf-border-soft)" }}
            />
          );
        }
        if (item.type === "label") {
          return (
            <div
              key={i}
              aria-hidden
              className="px-3 pt-1 pb-0.5 select-none"
              style={{ fontSize: 10, color: "var(--kf-text-muted)" }}
            >
              {item.label}
            </div>
          );
        }
        if (item.type === "colorRow") {
          return (
            <div key={i} role="group" className="flex items-center gap-1.5 px-3 py-1.5">
              {item.colors.map((c) => (
                <button
                  key={c.color}
                  role="menuitemradio"
                  aria-checked={!!c.selected}
                  title={c.label}
                  aria-label={c.label}
                  onClick={() => {
                    c.action();
                    onClose();
                  }}
                  className="rounded-full transition-transform hover:scale-125"
                  style={{
                    width: 16,
                    height: 16,
                    backgroundColor: c.color,
                    border: c.selected
                      ? "2px solid var(--kf-text-primary)"
                      : "2px solid transparent",
                    boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25)",
                  }}
                />
              ))}
            </div>
          );
        }
        return (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            className="kf-menu-item w-full flex items-center gap-2.5 px-2.5 mx-1 text-left transition-colors disabled:opacity-30"
            style={{ color: "var(--kf-text-primary)" }}
            onClick={() => {
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
          >
            <Icon name={item.icon} size={14} style={item.iconColor ? { color: item.iconColor } : undefined} />
            <span className="flex-1 truncate" style={item.emphasis ? { fontWeight: 600 } : undefined}>
              {item.label}
            </span>
            {item.shortcut && (
              <span className="shrink-0 pl-3" style={{ fontSize: 10, color: "var(--kf-text-muted)" }}>
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
