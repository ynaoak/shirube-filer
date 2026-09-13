import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

/**
 * カスタムタイトルバーのウィンドウ操作部品。
 *
 * 以前はこのファイルが独立したタイトルバー行を描画していたが、
 * 現在はグループタブバー（LayoutRoot）にウィンドウ操作を統合し、
 * フルパス表示は廃止した。ここでは再利用できる部品だけをエクスポートする:
 *  - useWindowControls(): OS 判定と最小化/最大化/閉じる
 *  - WinCaptionButtons:  Windows 風の四角ボタン（右）
 *
 * macOS はウィンドウ装飾を残し（tauri.macos.conf.json の titleBarStyle:
 * "Overlay"）、純正の traffic light をそのまま使うため自前のボタンは持たない。
 */

/** Tauri ウィンドウ操作（最小化/最大化/閉じる）と OS 判定をまとめたフック。 */
export function useWindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [platform, setPlatform] = useState<string>("");

  useEffect(() => {
    invoke<string>("get_platform").then(setPlatform).catch(() => setPlatform("windows"));
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => { win.isMaximized().then(setMaximized).catch(() => {}); })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  const win = getCurrentWindow();
  return {
    isMac: platform === "macos",
    maximized,
    minimize: () => win.minimize().catch(() => {}),
    toggleMax: () => win.toggleMaximize().catch(() => {}),
    close: () => win.close().catch(() => {}),
  };
}

// ── Windows caption buttons ──────────────────────────────────────────
export function WinCaptionButtons({
  maximized, onMinimize, onToggleMax, onClose,
}: {
  maximized: boolean;
  onMinimize: () => void;
  onToggleMax: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-stretch self-stretch shrink-0">
      <CaptionButton onClick={onMinimize} label={t("titleBar.minimize")} hover="var(--kf-bg-tertiary)">
        <Glyph kind="min" />
      </CaptionButton>
      <CaptionButton onClick={onToggleMax} label={maximized ? t("titleBar.restore") : t("titleBar.maximize")} hover="var(--kf-bg-tertiary)">
        <Glyph kind={maximized ? "restore" : "max"} />
      </CaptionButton>
      <CaptionButton onClick={onClose} label={t("titleBar.close")} hover="#e81123" hoverFg="#fff">
        <Glyph kind="close" />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  onClick, label, hover, hoverFg, children,
}: {
  onClick: () => void;
  label: string;
  hover: string;
  hoverFg?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="kf-caption-btn flex items-center justify-center transition-colors"
      style={{ width: 46, height: "100%", color: "var(--kf-text-secondary)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = hover;
        if (hoverFg) e.currentTarget.style.color = hoverFg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "";
        e.currentTarget.style.color = "var(--kf-text-secondary)";
      }}
      data-caption-btn="true"
    >
      {children}
    </button>
  );
}

/** Windows キャプションボタン風の 10px グリフ（SVG, currentColor）。 */
function Glyph({ kind }: { kind: "min" | "max" | "restore" | "close" }) {
  const s = 10;
  if (kind === "min") {
    return (
      <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden="true">
        <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "max") {
    return (
      <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden="true">
        <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  if (kind === "restore") {
    return (
      <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden="true">
        <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    );
  }
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}
