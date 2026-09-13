import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import Icon from "../common/Icon";
import { useVolumesChanged } from "../../lib/volumeWatch";
import { listMtpDevices, type MtpDevice } from "../../lib/mtp";

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 240;

type VolumeInfo = {
  path: string;
  label: string;
  totalBytes: number;
  freeBytes: number;
  kind: "fixed" | "removable" | "unknown";
};

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

type Props = {
  onNavigate: (path: string) => void;
  onClose: () => void;
  /** When true, hides the header and resize handle — width is controlled by parent. */
  controlled?: boolean;
};

export default function DrivePanel({ onNavigate, onClose, controlled = false }: Props) {
  const { t } = useTranslation();
  const [width, setWidth] = useState<number>(() => {
    const saved = localStorage.getItem("kf-drive-panel-width");
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return isNaN(parsed) ? DEFAULT_WIDTH : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
  });
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const dragStartXRef = useRef<number | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartXRef.current = e.clientX;
    const startWidth = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      if (dragStartXRef.current === null) return;
      const delta = ev.clientX - dragStartXRef.current;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(newWidth);
      localStorage.setItem("kf-drive-panel-width", String(newWidth));
    };
    const onUp = () => {
      dragStartXRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [mtpDevices, setMtpDevices] = useState<MtpDevice[]>([]);
  const [loading, setLoading] = useState(true);

  const loadVolumes = useCallback(() => {
    setLoading(true);
    invoke<VolumeInfo[]>("list_volumes")
      .then((vols) => { setVolumes(vols); setLoading(false); })
      .catch(() => setLoading(false));
    // MTP デバイス（スマホ等）はドライブレターを持たないため別途列挙する。
    listMtpDevices().then(setMtpDevices).catch(() => setMtpDevices([]));
  }, []);

  useEffect(() => { loadVolumes(); }, [loadVolumes]);
  // USB / スマートフォン等の抜き差しで一覧を自動更新する。
  useVolumesChanged(loadVolumes);

  return (
    <div
      className={controlled ? "flex flex-col flex-1 text-xs overflow-hidden" : "flex-shrink-0 flex flex-col border-r text-xs overflow-hidden relative"}
      style={controlled ? {
        backgroundColor: "var(--kf-bg-primary)",
        color: "var(--kf-text-primary)",
      } : {
        width,
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* リサイズハンドル — hidden in controlled mode */}
      {!controlled && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500 hover:opacity-60"
          style={{ touchAction: "none" }}
          onMouseDown={handleDragStart}
        />
      )}

      {/* ヘッダー — hidden in controlled mode */}
      {!controlled && (
        <div
          className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          <Icon name="storage" size={14} style={{ color: "var(--kf-text-muted)" }} />
          <span className="flex-1 font-semibold" style={{ color: "var(--kf-text-primary)" }}>
            {t("drivePanel.title")}
          </span>
          <button
            onClick={loadVolumes}
            className="flex items-center opacity-60 hover:opacity-100"
            style={{ color: "var(--kf-text-muted)" }}
            title={t("drivePanel.refresh")}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            onClick={onClose}
            className="flex items-center opacity-60 hover:opacity-100"
            style={{ color: "var(--kf-text-muted)" }}
            title={t("drivePanel.close")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {/* ドライブ一覧 */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-6 opacity-40">
            <Icon name="refresh" size={18} />
          </div>
        )}
        {!loading && volumes.length === 0 && mtpDevices.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 gap-1 opacity-40">
            <Icon name="storage" size={22} />
            <span>{t("drivePanel.notFound")}</span>
          </div>
        )}

        {/* MTP デバイス（スマホ等）。ドライブレターを持たないため別枠で表示。 */}
        {mtpDevices.map((dev) => (
          <div
            key={`mtp:${dev.name}`}
            className="flex items-center gap-2 px-3 py-2.5 cursor-pointer border-b"
            style={{ borderColor: "var(--kf-border-soft)", transition: "background-color 0.1s" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
            onClick={() => onNavigate(`mtp://${dev.name}`)}
            title={dev.name}
          >
            <Icon name="smartphone" size={18} style={{ color: "var(--kf-accent)", flexShrink: 0 }} />
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate" style={{ fontSize: 12 }}>{dev.name}</div>
            </div>
            <span
              className="px-1 rounded shrink-0"
              style={{ fontSize: 9, backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-muted)" }}
            >
              {t("drivePanel.mtp")}
            </span>
          </div>
        ))}
        {!loading && volumes.map((vol) => {
          const usedBytes = vol.totalBytes - vol.freeBytes;
          const usedPct = vol.totalBytes > 0 ? Math.round((usedBytes / vol.totalBytes) * 100) : 0;
          const isAlmostFull = usedPct >= 90;
          const barColor = isAlmostFull ? "var(--kf-error)" : "var(--kf-accent)";
          const driveIcon =
            vol.kind === "removable" ? "usb" :
            vol.totalBytes === 0 ? "optical_disc" :
            "hard_drive";

          return (
            <div
              key={vol.path}
              className="flex flex-col gap-1 px-3 py-2.5 cursor-pointer border-b"
              style={{
                borderColor: "var(--kf-border-soft)",
                transition: "background-color 0.1s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
              onClick={() => onNavigate(vol.path)}
              title={vol.path}
            >
              {/* ドライブ名・パス */}
              {(() => {
                const driveLetter = vol.path.replace(/[\\/]$/, ""); // "C:" など
                const label = vol.label ? `${driveLetter}  ${vol.label}` : driveLetter;
                return (
                  <div className="flex items-center gap-2">
                    <Icon name={driveIcon} size={18} style={{ color: "var(--kf-accent)", flexShrink: 0 }} />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate" style={{ fontSize: 12 }}>
                        {label}
                      </div>
                    </div>
                    {vol.kind === "removable" && (
                      <span
                        className="px-1 rounded shrink-0"
                        style={{ fontSize: 9, backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-muted)" }}
                      >
                        {t("drivePanel.removable")}
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* 容量グラフ */}
              {vol.totalBytes > 0 && (
                <div className="pl-7 flex flex-col gap-1">
                  <div
                    className="w-full rounded-full overflow-hidden"
                    style={{ height: 4, backgroundColor: "var(--kf-border)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${usedPct}%`,
                        backgroundColor: barColor,
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-0.5" style={{ fontSize: 10, color: "var(--kf-text-muted)" }}>
                    <span className="whitespace-nowrap">{t("drivePanel.free")}　{formatBytes(vol.freeBytes)}</span>
                    <span className="whitespace-nowrap" style={{ color: isAlmostFull ? "var(--kf-error)" : undefined }}>
                      {t("drivePanel.used")}　{usedPct}%
                    </span>
                    <span className="whitespace-nowrap">{t("drivePanel.total")}　{formatBytes(vol.totalBytes)}</span>
                  </div>
                </div>
              )}
              {vol.totalBytes === 0 && (
                <div className="pl-7 text-[10px]" style={{ color: "var(--kf-text-muted)" }}>
                  {t("drivePanel.noCapacity")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
