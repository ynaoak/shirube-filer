import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useAddons } from "../../store/addonStore";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";

type AddonInfo = {
  meta: { id: string; name: string; version: string; description: string; author: string; license: string };
  enabled: boolean;
  dir: string;
};

type Props = {
  onClose: () => void;
};

export default function AddonManager({ onClose }: Props) {
  const { t } = useTranslation();
  const dialogRef = useModal<HTMLDivElement>({ onClose });
  const { addons, setEnabled, reload } = useAddons();
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);

  const handleInstall = async () => {
    setInstallError(null);
    try {
      const selected = await open({
        title: t("addonManager.selectZip"),
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
        multiple: false,
        directory: false,
      });
      if (!selected) return;
      setInstalling(true);
      await invoke<AddonInfo>("install_addon", { zipPath: selected as string });
      reload();
    } catch (e) {
      setInstallError(typeof e === "string" ? e : t("addonManager.installFailed"));
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (id: string, name: string) => {
    if (!window.confirm(t("addonManager.confirmUninstall", { name }) + "\n" + t("addonManager.confirmUninstallNote"))) return;
    setUninstallingId(id);
    try {
      await invoke("uninstall_addon", { id });
      reload();
    } catch (e) {
      setInstallError(typeof e === "string" ? e : t("addonManager.uninstallFailed"));
    } finally {
      setUninstallingId(null);
    }
  };

  return (
    <div className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("addonManager.title", "アドオン")}
        className="kf-anim-scale rounded-lg w-[520px] max-h-[70vh] flex flex-col shadow-xl border"
        style={{
          backgroundColor: "var(--kf-bg-secondary)",
          borderColor: "var(--kf-border)",
        }}
      >
        {/* ヘッダー */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: "var(--kf-border)" }}
        >
          <h2 className="text-sm font-semibold" style={{ color: "var(--kf-text-primary)" }}>
            {t("addonManager.title")}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleInstall}
              disabled={installing}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded disabled:opacity-40"
              style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
            >
              <Icon name="install_desktop" size={13} />
              {installing ? t("addonManager.installing") : t("addonManager.installFromZip")}
            </button>
            <button
              onClick={reload}
              className="flex items-center text-xs px-2 py-1 rounded opacity-60 hover:opacity-100"
              style={{ color: "var(--kf-text-secondary)" }}
            >
              <Icon name="refresh" size={13} />
            </button>
            <button aria-label={t("common.close")}
              onClick={onClose}
              className="flex items-center opacity-60 hover:opacity-100"
              style={{ color: "var(--kf-text-primary)" }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>

        {installError && (
          <div className="px-4 py-2 text-xs text-red-400 border-b" style={{ borderColor: "var(--kf-border)" }}>
            {installError}
          </div>
        )}

        {/* アドオン一覧 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {addons.length === 0 && (
            <p className="text-center text-xs py-8" style={{ color: "var(--kf-text-muted)" }}>
              {t("addonManager.noAddons")}
              <br />
              <span style={{ opacity: 0.6 }}>{t("addonManager.noAddonsHint")}</span>
            </p>
          )}
          {addons.map((addon) => (
            <div
              key={addon.meta.id}
              className="flex items-start gap-3 p-3 rounded border"
              style={{
                backgroundColor: "var(--kf-bg-primary)",
                borderColor: "var(--kf-border)",
              }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate" style={{ color: "var(--kf-text-primary)" }}>
                    {addon.meta.name}
                  </span>
                  <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>
                    v{addon.meta.version}
                  </span>
                </div>
                <p className="text-xs mt-0.5 truncate" style={{ color: "var(--kf-text-secondary)" }}>
                  {addon.meta.description}
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--kf-text-muted)" }}>
                  {addon.meta.author} · {addon.meta.license}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0 mt-0.5">
                {/* アンインストールボタン */}
                <button
                  onClick={() => handleUninstall(addon.meta.id, addon.meta.name)}
                  disabled={uninstallingId === addon.meta.id}
                  className="flex items-center opacity-40 hover:opacity-80 disabled:opacity-20"
                  title={t("addonManager.uninstall")}
                  style={{ color: "var(--kf-error)" }}
                >
                  <Icon name="delete" size={14} />
                </button>

                {/* 有効/無効トグル */}
                <button
                  onClick={() => setEnabled(addon.meta.id, !addon.enabled)}
                  className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                  style={{
                    backgroundColor: addon.enabled ? "var(--kf-accent)" : "var(--kf-bg-tertiary, #444)",
                  }}
                  title={addon.enabled ? t("addonManager.disable") : t("addonManager.enable")}
                >
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform"
                    style={{ transform: addon.enabled ? "translateX(18px)" : "translateX(2px)" }}
                  />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
