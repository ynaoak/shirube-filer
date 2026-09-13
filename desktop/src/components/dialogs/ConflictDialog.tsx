import { useTranslation } from "react-i18next";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";

export type ConflictResolution = "overwrite" | "skip" | "rename" | "cancel";

type ConflictFile = { src: string; dest: string };

type Props = {
  files: ConflictFile[];
  onResolve: (r: ConflictResolution) => void;
};

export default function ConflictDialog({ files, onResolve }: Props) {
  const { t } = useTranslation();
  // 初期フォーカスは「自動リネーム」（下の autoFocus 属性）に当てる。
  // 既定の autoFocus だと DOM 順で先頭の「キャンセル」に当たり、Enter が
  // 何もしない選択になってしまう。データを失わず作業も進む自動リネームを
  // Enter の既定にする（破壊的な「上書き」は明示的な操作のみ）。
  const dialogRef = useModal<HTMLDivElement>({ onClose: () => onResolve("cancel"), autoFocus: false });
  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onResolve("cancel"); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("conflictDialog.title", "ファイルの競合")}
        className="kf-anim-scale rounded-lg shadow-xl flex flex-col text-xs overflow-hidden"
        style={{
          width: 440,
          maxHeight: "70vh",
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
          <Icon name="warning" size={14} style={{ color: "var(--kf-warning)" }} />
          <span>{t("conflictDialog.title", { count: files.length })}</span>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
          <p style={{ color: "var(--kf-text-secondary)" }}>
            {t("conflictDialog.description")}
          </p>
          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
            {files.map((f, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2 py-1 rounded"
                style={{ backgroundColor: "var(--kf-bg-secondary)" }}
              >
                <Icon name="description" size={12} style={{ color: "var(--kf-text-muted)" }} />
                <span className="truncate" style={{ color: "var(--kf-text-primary)" }}>
                  {f.dest.split(/[\\/]/).pop()}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-4 py-2.5 border-t flex-wrap"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <button
            onClick={() => onResolve("cancel")}
            className="px-3 py-1 rounded opacity-70 hover:opacity-100"
            style={{ border: "1px solid var(--kf-border)" }}
          >
            {t("conflictDialog.cancel")}
          </button>
          <button
            onClick={() => onResolve("skip")}
            className="px-3 py-1 rounded opacity-70 hover:opacity-100"
            style={{ border: "1px solid var(--kf-border)" }}
          >
            {t("conflictDialog.skipAll")}
          </button>
          <button
            autoFocus
            onClick={() => onResolve("rename")}
            className="px-3 py-1 rounded opacity-90 hover:opacity-100 focus-visible:outline-2"
            style={{ border: "1px solid var(--kf-accent)", outlineColor: "var(--kf-accent)" }}
          >
            {t("conflictDialog.autoRename")}
          </button>
          <button
            onClick={() => onResolve("overwrite")}
            className="px-3 py-1 rounded font-semibold"
            style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
          >
            {t("conflictDialog.overwriteAll")}
          </button>
        </div>
      </div>
    </div>
  );
}
