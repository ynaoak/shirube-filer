import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";

type CompressFormat = "zip" | "targz" | "zstd";

const FORMAT_OPTIONS: { value: CompressFormat; label: string; ext: string }[] = [
  { value: "zip",   label: "ZIP (.zip)",       ext: ".zip" },
  { value: "targz", label: "tar.gz (.tar.gz)", ext: ".tar.gz" },
  { value: "zstd",  label: "Zstandard (.zst)", ext: ".zst" },
];

type Props = {
  sources: string[];
  destDir: string;
  defaultName: string;
  onClose: () => void;
  onDone: () => void;
};

export default function CompressDialog({ sources, destDir, defaultName, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const dialogRef = useModal<HTMLDivElement>({ onClose, closeOnEsc: false });
  // destDir がすでにセパレータで終わっている場合（ルートディレクトリなど）に
  // 区切り文字が重複しないよう、末尾のセパレータを一度だけ取り除く
  const dirBase = destDir.replace(/[\\/]+$/, "");
  const sep = destDir.includes("\\") ? "\\" : "/";
  const [format, setFormat] = useState<CompressFormat>("zip");
  const [name, setName] = useState(defaultName);
  const [compressing, setCompressing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ext = FORMAT_OPTIONS.find((o) => o.value === format)!.ext;
  // Strip any known extension from name for display
  const baseName = name.replace(/\.(zip|tar\.gz|tgz|zst|zstd)$/i, "");

  const handleCompress = async () => {
    if (!baseName.trim()) return;
    setCompressing(true);
    setError(null);
    const dest = `${dirBase}${sep}${baseName.trim()}${ext}`;
    try {
      await invoke("compress", { sources, dest, format });
      onDone();
      onClose();
    } catch (e) {
      console.error("[compress]", e);
      setError(`${t("compress.errorFailed")}: ${e}`);
      setCompressing(false);
    }
  };

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("compress.title", "圧縮")}
        className="kf-anim-scale rounded-lg shadow-xl flex flex-col text-xs overflow-hidden"
        style={{
          width: 400,
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b font-semibold"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <Icon name="folder_zip" size={14} style={{ color: "var(--kf-accent)" }} />
          <span>{t("compress.compress")} {t("compress.sourceCount", { count: sources.length })}</span>
          <div className="flex-1" />
          <button aria-label={t("common.close")} onClick={onClose} className="opacity-50 hover:opacity-100 flex items-center">
            <Icon name="close" size={13} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 flex flex-col gap-3">
          {/* Format selector */}
          <div className="flex flex-col gap-1">
            <label style={{ color: "var(--kf-text-muted)" }}>{t("compress.labelFormat")}</label>
            <div className="flex gap-2 flex-wrap">
              {FORMAT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setFormat(opt.value)}
                  className="px-3 py-1 rounded transition-colors"
                  style={{
                    backgroundColor: format === opt.value ? "var(--kf-accent)" : "var(--kf-bg-secondary)",
                    color: format === opt.value ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-secondary)",
                    border: `1px solid ${format === opt.value ? "var(--kf-accent)" : "var(--kf-border)"}`,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Output filename */}
          <div className="flex flex-col gap-1">
            <label style={{ color: "var(--kf-text-muted)" }}>{t("compress.labelOutputName")}</label>
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={baseName}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCompress(); if (e.key === "Escape") onClose(); }}
                className="flex-1 rounded px-2 py-1 outline-none"
                style={{
                  backgroundColor: "var(--kf-bg-secondary)",
                  border: "1px solid var(--kf-border)",
                  color: "var(--kf-text-primary)",
                }}
              />
              <span style={{ color: "var(--kf-text-muted)", flexShrink: 0 }}>{ext}</span>
            </div>
            <span className="truncate" style={{ color: "var(--kf-text-muted)" }}>
              → {dirBase}{sep}{baseName.trim() || "..."}{ext}
            </span>
          </div>

          {error && <p style={{ color: "var(--kf-error)" }}>{error}</p>}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-4 py-2 border-t"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <button
            onClick={onClose}
            className="px-3 py-1 rounded opacity-70 hover:opacity-100"
            style={{ border: "1px solid var(--kf-border)" }}
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleCompress}
            disabled={compressing || !baseName.trim()}
            className="px-3 py-1 rounded font-semibold disabled:opacity-40 flex items-center gap-1"
            style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
          >
            {compressing && <Icon name="progress_activity" size={12} className="animate-spin" />}
            {compressing ? t("compress.compressing") : t("compress.compress")}
          </button>
        </div>
      </div>
    </div>
  );
}
