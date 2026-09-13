import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TOAST_EVENT, ToastEvent, ToastType } from "../../lib/toast";
import Icon from "./Icon";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

const TYPE_ICON: Record<ToastType, string> = {
  error:   "error",
  warning: "warning",
  info:    "info",
  success: "check_circle",
};

// ステータス色はトークン経由で引く（App.css の Semantic status colors）。
// アクセントを直接使わないこと: 淡いアクセントだと左帯とアイコンが背景に沈む。
// --kf-info はアクセントの色味をテキスト色側へ寄せて明るさを揃えたもの。
const TYPE_COLOR: Record<ToastType, string> = {
  error:   "var(--kf-error)",
  warning: "var(--kf-warning)",
  info:    "var(--kf-info)",
  success: "var(--kf-success)",
};

// エラーは読む時間が要るので長め、その他は標準的な 4 秒。
const TYPE_DURATION: Record<ToastType, number> = {
  error:   6000,
  warning: 5000,
  info:    4000,
  success: 4000,
};

// 同時表示は最新の数件に絞り、画面を埋め尽くさない。
const MAX_VISIBLE = 4;

let nextId = 0;

export default function ToastHost() {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { message, type } = (e as CustomEvent<ToastEvent>).detail;
      const id = ++nextId;
      setToasts((prev) => [...prev, { id, message, type }].slice(-MAX_VISIBLE));
    };
    window.addEventListener(TOAST_EVENT, handler);
    return () => window.removeEventListener(TOAST_EVENT, handler);
  }, []);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed z-[200] flex flex-col gap-2 pointer-events-none"
      style={{ bottom: 36, right: 16 }}
      role="region"
      aria-label={t("common.notifications")}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={remove} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  const [leaving, setLeaving] = useState(false);
  const duration = TYPE_DURATION[toast.type];

  // 残り時間ベースのタイマー。ホバー中は一時停止し、離れたら残り時間で再開する。
  const remainingRef = useRef(duration);
  const startRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginLeave = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => onDismiss(toast.id), 160);
  }, [onDismiss, toast.id]);

  const clear = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const resume = useCallback(() => {
    clear();
    startRef.current = Date.now();
    timerRef.current = setTimeout(beginLeave, remainingRef.current);
  }, [beginLeave]);

  const pause = useCallback(() => {
    clear();
    remainingRef.current -= Date.now() - startRef.current;
  }, []);

  useEffect(() => {
    resume();
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const color = TYPE_COLOR[toast.type];

  return (
    <div
      className={`kf-toast relative flex items-start gap-2 pl-3 pr-2 py-2 rounded-lg shadow-xl text-xs pointer-events-auto overflow-hidden${leaving ? " kf-toast--leaving" : ""}`}
      style={{
        backgroundColor: "var(--kf-bg-secondary)",
        border: "1px solid var(--kf-border)",
        borderLeft: `3px solid ${color}`,
        color: "var(--kf-text-primary)",
        maxWidth: 360,
        minWidth: 220,
      }}
      role={toast.type === "error" || toast.type === "warning" ? "alert" : "status"}
      aria-live={toast.type === "error" || toast.type === "warning" ? "assertive" : "polite"}
      onMouseEnter={pause}
      onMouseLeave={resume}
    >
      <Icon name={TYPE_ICON[toast.type]} size={14} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <span className="flex-1 leading-snug break-words">{toast.message}</span>
      <button
        type="button"
        onClick={beginLeave}
        aria-label={t("common.close")}
        title={t("common.close")}
        className="shrink-0 grid place-items-center rounded transition-colors"
        style={{ width: 18, height: 18, color: "var(--kf-text-muted)" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = "var(--kf-bg-tertiary)";
          e.currentTarget.style.color = "var(--kf-text-primary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--kf-text-muted)";
        }}
      >
        <Icon name="close" size={13} />
      </button>
      {/* 残り時間のプログレスバー（ホバーで一時停止） */}
      <div
        className="kf-toast__progress absolute bottom-0 left-0 h-[2px] w-full"
        style={{ backgroundColor: color, opacity: 0.5, animationDuration: `${duration}ms` }}
      />
    </div>
  );
}
