import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAddons } from "../../store/addonStore";
import EmptyState from "../common/EmptyState";
import Icon from "../common/Icon";

type Props = {
  addonId: string;
  currentPath: string;
  paneId?: string;
  onClose?: () => void;
};

export default function AddonPanel({ addonId, currentPath, paneId, onClose }: Props) {
  const { t } = useTranslation();
  const { loaded } = useAddons();

  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
  const addon = loaded.get(addonId);

  if (!addon) {
    return (
      <div
        className="w-64 flex-shrink-0 flex items-center justify-center border-l text-xs"
        style={{
          backgroundColor: "var(--kf-bg-primary)",
          borderColor: "var(--kf-border)",
        }}
      >
        <EmptyState icon="extension_off" size={28} message={t("addonPanel.notFound", "アドオンが見つかりません")} />
      </div>
    );
  }

  const { Component, info } = addon;

  return (
    <div
      className="w-72 flex-shrink-0 flex flex-col border-l overflow-hidden text-xs"
      style={{
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* ヘッダー */}
      <div
        className="flex items-center gap-1 px-3 py-2 border-b shrink-0"
        style={{
          backgroundColor: "var(--kf-bg-secondary)",
          borderColor: "var(--kf-border)",
          color: "var(--kf-text-muted)",
        }}
      >
        <Icon name="extension" size={14} />
        <span className="font-semibold flex-1" style={{ color: "var(--kf-text-primary)" }}>
          {info.meta.name}
        </span>
        {onClose && (
          <button onClick={onClose} className="toolbar-btn" title={t("addonPanel.close")} style={{ padding: 2 }}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        <Component paneId={paneId} currentPath={currentPath} />
      </div>
    </div>
  );
}
