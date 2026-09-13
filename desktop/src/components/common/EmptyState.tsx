import { ReactNode } from "react";
import Icon from "./Icon";

interface Props {
  /** Material Symbols のアイコン名 */
  icon: string;
  /** 主要メッセージ */
  message: string;
  /** 補足説明（任意） */
  hint?: string;
  /** 行動を促すアクション（任意） */
  action?: { label: string; icon?: string; onClick: () => void };
  /** アイコンサイズ。一覧用は大きめ(40)、サイドパネル用は小さめ(20) */
  size?: number;
  className?: string;
  children?: ReactNode;
}

/**
 * 空状態（検索ヒットなし / 項目ゼロ など）の統一表示。
 * アイコン＋メッセージ＋任意の補足・アクションで「何も無い理由」と「次の一手」を示す。
 */
export default function EmptyState({
  icon,
  message,
  hint,
  action,
  size = 40,
  className = "",
  children,
}: Props) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 text-center px-6 py-8 ${className}`}
      style={{ color: "var(--kf-text-muted)" }}
    >
      <Icon name={icon} size={size} style={{ opacity: 0.3 }} />
      <div className="flex flex-col items-center gap-1">
        <span className="text-sm" style={{ color: "var(--kf-text-secondary)" }}>
          {message}
        </span>
        {hint && <span className="text-xs" style={{ opacity: 0.8 }}>{hint}</span>}
      </div>
      {action && (
        <button type="button" className="kf-btn-secondary mt-1" onClick={action.onClick}>
          {action.icon && <Icon name={action.icon} size={14} />}
          {action.label}
        </button>
      )}
      {children}
    </div>
  );
}
