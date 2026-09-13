import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { FileMetadata } from "../../types/fs";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";

const IS_WINDOWS = navigator.platform.startsWith("Win");

const EXIF_IMAGE_EXTS = new Set(["jpg", "jpeg", "tiff", "tif", "heic", "heif", "webp"]);

type ExifData = {
  make?: string; model?: string; software?: string; artist?: string; copyright?: string;
  datetime?: string; datetimeOriginal?: string; datetimeDigitized?: string;
  imageWidth?: number; imageHeight?: number; orientation?: number;
  exposureTime?: string; fNumber?: string; isoSpeed?: number;
  focalLength?: string; exposureBias?: string; meteringMode?: string;
  flash?: string; whiteBalance?: string;
  gpsLatitude?: number; gpsLongitude?: number; gpsAltitude?: number;
};

type Props = {
  path: string;
  onClose: () => void;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 py-0.5 items-start">
      <span style={{ color: "var(--kf-text-muted)" }}>{label}</span>
      <span className="break-all" style={{ color: "var(--kf-text-primary)" }}>
        {value}
      </span>
    </div>
  );
}

type Tab = "general" | "exif";

export default function PropertiesDialog({ path, onClose }: Props) {
  const { t } = useTranslation();
  const dialogRef = useModal<HTMLDivElement>({ onClose });
  const [meta, setMeta] = useState<FileMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editReadonly, setEditReadonly] = useState<boolean | null>(null);
  const [editHidden, setEditHidden] = useState<boolean | null>(null);
  const [checksum, setChecksum] = useState<{ md5: string; sha256: string } | "loading" | null>(null);
  const [tab, setTab] = useState<Tab>("general");
  const [exif, setExif] = useState<ExifData | null>(null);
  const [exifError, setExifError] = useState<string | null>(null);
  const [exifLoading, setExifLoading] = useState(false);

  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const isExifSupported = EXIF_IMAGE_EXTS.has(ext);

  const fetchMeta = () => {
    invoke<FileMetadata>("get_file_metadata", { path })
      .then((m) => {
        // バックエンドが不正な形（null/配列など）を返してもクラッシュしない
        if (!m || typeof m !== "object" || Array.isArray(m) || typeof (m as FileMetadata).size !== "number") {
          setError(t("properties.failedGetInfo"));
          return;
        }
        setMeta(m);
        setEditReadonly(m.readonly);
        setEditHidden(m.isHidden);
        // Trigger checksum calculation for files only
        if (!m.isDir) {
          setChecksum("loading");
          invoke<[string, string]>("get_checksum", { path })
            .then(([md5, sha256]) => setChecksum({ md5, sha256 }))
            .catch(() => setChecksum(null));
        }
      })
      .catch((e) => { console.error("[get_file_metadata]", e); setError(t("properties.failedGetInfo")); });
  };

  useEffect(() => { fetchMeta(); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load Exif when switching to exif tab
  useEffect(() => {
    if (tab !== "exif" || !isExifSupported) return;
    if (exif !== null || exifLoading) return;
    setExifLoading(true);
    invoke<ExifData>("get_exif_data", { path })
      .then((d) => setExif(d))
      .catch((e) => setExifError(String(e)))
      .finally(() => setExifLoading(false));
  }, [tab, path, isExifSupported]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveAttrs = async () => {
    if (!meta || editReadonly === null) return;
    setSaving(true);
    try {
      if (editReadonly !== meta.readonly) {
        await invoke("set_file_readonly", { path, readonly: editReadonly });
      }
      if (IS_WINDOWS && editHidden !== null && editHidden !== meta.isHidden) {
        await invoke("set_file_hidden", { path, hidden: editHidden });
      }
      fetchMeta();
    } catch (e) {
      console.error("[set_file_attrs]", e);
      setError(t("properties.failedChangeAttr"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("properties.title", "プロパティ")}
        className="kf-anim-scale rounded-lg shadow-xl text-xs overflow-hidden"
        style={{
          backgroundColor: "var(--kf-bg-primary)",
          color: "var(--kf-text-primary)",
          border: "1px solid var(--kf-border)",
          width: isExifSupported ? 440 : 384,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div
          className="flex items-center gap-2 px-4 py-3 border-b"
          style={{
            backgroundColor: "var(--kf-bg-secondary)",
            borderColor: "var(--kf-border)",
          }}
        >
          <Icon name="info" size={15} style={{ color: "var(--kf-text-muted)" }} />
          <span className="flex-1 font-semibold truncate">
            {meta?.name ?? path.split(/[\\/]/).pop() ?? path}
          </span>
          <button aria-label={t("common.close")}
            onClick={onClose}
            className="flex items-center opacity-50 hover:opacity-100"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* タブ（Exif 対応画像のみ） */}
        {isExifSupported && (
          <div
            className="flex border-b"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
          >
            {(["general", "exif"] as Tab[]).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                className="px-4 py-1.5 font-medium"
                style={{
                  color: tab === tabKey ? "var(--kf-accent)" : "var(--kf-text-muted)",
                  borderBottom: tab === tabKey ? "2px solid var(--kf-accent)" : "2px solid transparent",
                }}
              >
                {tabKey === "general" ? t("properties.tabGeneral") : t("properties.tabExif")}
              </button>
            ))}
          </div>
        )}

        {/* コンテンツ */}
        <div className="px-4 py-3 space-y-0.5" style={{ maxHeight: 480, overflowY: "auto" }}>
          {/* Exif タブ */}
          {tab === "exif" && isExifSupported && (
            <>
              {exifLoading && (
                <div className="flex items-center gap-2 py-4 justify-center" style={{ color: "var(--kf-text-muted)" }}>
                  <Icon name="progress_activity" size={16} className="animate-spin" />
                  {t("common.loading")}
                </div>
              )}
              {exifError && (
                <div className="py-4 text-center" style={{ color: "var(--kf-text-muted)" }}>
                  {t("exif.noData")}
                </div>
              )}
              {exif && !exifLoading && (
                <>
                  {(exif.make || exif.model) && (
                    <>
                      <Row label={t("properties.exifMake")} value={exif.make ?? "—"} />
                      <Row label={t("properties.exifModel")} value={exif.model ?? "—"} />
                    </>
                  )}
                  {exif.software && <Row label={t("properties.exifSoftware")} value={exif.software} />}
                  {exif.artist && <Row label={t("properties.exifArtist")} value={exif.artist} />}
                  {exif.copyright && <Row label={t("properties.exifCopyright")} value={exif.copyright} />}
                  {(exif.make || exif.model || exif.software) && (
                    <div className="my-2 border-t" style={{ borderColor: "var(--kf-border-soft)" }} />
                  )}
                  {exif.datetimeOriginal && <Row label={t("properties.exifDateTimeOriginal")} value={exif.datetimeOriginal} />}
                  {exif.datetime && !exif.datetimeOriginal && <Row label={t("properties.exifDateTime")} value={exif.datetime} />}
                  {(exif.imageWidth || exif.imageHeight) && (
                    <Row label={t("properties.exifResolution")} value={`${exif.imageWidth ?? "?"} × ${exif.imageHeight ?? "?"} px`} />
                  )}
                  {exif.orientation !== undefined && (
                    <Row label={t("properties.exifOrientation")} value={(() => {
                      const map: Record<number, string> = { 1:"Normal", 3:"180°", 6:"90° CW", 8:"90° CCW" };
                      return map[exif.orientation!] ?? `${exif.orientation}`;
                    })()} />
                  )}
                  {(exif.exposureTime || exif.fNumber || exif.isoSpeed) && (
                    <div className="my-2 border-t" style={{ borderColor: "var(--kf-border-soft)" }} />
                  )}
                  {exif.exposureTime && <Row label={t("properties.exifExposureTime")} value={exif.exposureTime} />}
                  {exif.fNumber && <Row label={t("properties.exifFNumber")} value={exif.fNumber} />}
                  {exif.isoSpeed !== undefined && <Row label={t("properties.exifISO")} value={String(exif.isoSpeed)} />}
                  {exif.focalLength && <Row label={t("properties.exifFocalLength")} value={exif.focalLength} />}
                  {exif.exposureBias && <Row label={t("properties.exifExposureBias")} value={exif.exposureBias} />}
                  {exif.meteringMode && <Row label={t("properties.exifMeteringMode")} value={exif.meteringMode} />}
                  {exif.flash && <Row label={t("properties.exifFlash")} value={exif.flash} />}
                  {exif.whiteBalance && <Row label={t("properties.exifWhiteBalance")} value={exif.whiteBalance} />}
                  {(exif.gpsLatitude !== undefined || exif.gpsLongitude !== undefined) && (
                    <>
                      <div className="my-2 border-t" style={{ borderColor: "var(--kf-border-soft)" }} />
                      <Row
                        label={t("properties.exifGPS")}
                        value={
                          <span>
                            {exif.gpsLatitude?.toFixed(6)}, {exif.gpsLongitude?.toFixed(6)}
                            {" "}
                            <a
                              href={`https://maps.google.com/?q=${exif.gpsLatitude},${exif.gpsLongitude}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: "var(--kf-accent)" }}
                            >
                              {t("exif.openMap")}
                            </a>
                          </span>
                        }
                      />
                      {exif.gpsAltitude !== undefined && (
                        <Row label={t("properties.exifAltitude")} value={`${exif.gpsAltitude.toFixed(1)} m`} />
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}

          {tab === "general" && error && (
            <p style={{ color: "var(--kf-text-muted)" }}>{error}</p>
          )}
          {tab === "general" && meta && (
            <>
              <Row label={t("properties.propPath")} value={meta.path} />
              <Row
                label={t("properties.propType")}
                value={
                  meta.isSymlink
                    ? t("properties.propTypeSymlink")
                    : meta.isDir
                    ? t("properties.propTypeFolder")
                    : t("properties.propTypeFile")
                }
              />
              {!meta.isDir && (
                <Row
                  label={t("properties.propSize")}
                  value={`${formatSize(meta.size)} (${meta.size.toLocaleString()} B)`}
                />
              )}
              {meta.symlinkTarget && (
                <Row label={t("properties.propLinkTarget")} value={meta.symlinkTarget} />
              )}
              <div
                className="my-2 border-t"
                style={{ borderColor: "var(--kf-border-soft)" }}
              />
              <Row label={t("properties.propCreated")} value={formatDate(meta.created)} />
              <Row label={t("properties.propModified")} value={formatDate(meta.modified)} />
              <Row label={t("properties.propAccessed")} value={formatDate(meta.accessed)} />
              <div
                className="my-2 border-t"
                style={{ borderColor: "var(--kf-border-soft)" }}
              />
              {/* 読み取り専用トグル */}
              <div className="grid grid-cols-[6rem_1fr] gap-2 py-0.5 items-center">
                <span style={{ color: "var(--kf-text-muted)" }}>{t("properties.readonly")}</span>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={editReadonly ?? meta.readonly}
                    onChange={(e) => setEditReadonly(e.target.checked)}
                    className="accent-[var(--kf-accent)]"
                  />
                  <span>{(editReadonly ?? meta.readonly) ? t("common.yes") : t("common.no")}</span>
                </label>
              </div>
              {/* 隠しファイルトグル（Windows のみ編集可） */}
              <div className="grid grid-cols-[6rem_1fr] gap-2 py-0.5 items-center">
                <span style={{ color: "var(--kf-text-muted)" }}>{t("properties.hidden")}</span>
                {IS_WINDOWS ? (
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={editHidden ?? meta.isHidden}
                      onChange={(e) => setEditHidden(e.target.checked)}
                      className="accent-[var(--kf-accent)]"
                    />
                    <span>{(editHidden ?? meta.isHidden) ? t("common.yes") : t("common.no")}</span>
                  </label>
                ) : (
                  <span style={{ color: "var(--kf-text-primary)" }}>
                    {meta.isHidden ? t("common.yes") : t("common.no")}
                    <span className="ml-1 text-[9px]" style={{ color: "var(--kf-text-muted)" }}>{t("properties.readonlyNote")}</span>
                  </span>
                )}
              </div>
              {meta.permissions && (
                <Row
                  label={t("properties.propPermissions")}
                  value={
                    <span
                      className="font-mono"
                      style={{ color: "var(--kf-accent)" }}
                    >
                      {meta.permissions}
                    </span>
                  }
                />
              )}
              {/* チェックサム（ファイルのみ） */}
              {checksum !== null && (
                <>
                  <div
                    className="my-2 border-t"
                    style={{ borderColor: "var(--kf-border-soft)" }}
                  />
                  <Row
                    label={t("properties.propMd5")}
                    value={
                      checksum === "loading"
                        ? <span style={{ color: "var(--kf-text-muted)" }}>{t("properties.calculating")}</span>
                        : <span className="font-mono text-[10px] break-all" style={{ color: "var(--kf-text-secondary)" }}>{checksum.md5}</span>
                    }
                  />
                  <Row
                    label={t("properties.propSha256")}
                    value={
                      checksum === "loading"
                        ? <span style={{ color: "var(--kf-text-muted)" }}>{t("properties.calculating")}</span>
                        : <span className="font-mono text-[10px] break-all" style={{ color: "var(--kf-text-secondary)" }}>{checksum.sha256}</span>
                    }
                  />
                </>
              )}
            </>
          )}
          {tab === "general" && !meta && !error && (
            <div
              className="flex items-center gap-2 py-4 justify-center"
              style={{ color: "var(--kf-text-muted)" }}
            >
              <Icon name="progress_activity" size={16} className="animate-spin" />
              {t("common.loading")}
            </div>
          )}
        </div>

        {/* フッター（属性変更ボタン） */}
        {tab === "general" && meta && (
          <div
            className="flex items-center justify-end gap-2 px-4 py-2 border-t"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
          >
            <button
              onClick={onClose}
              className="px-3 py-1 rounded opacity-70 hover:opacity-100"
              style={{ border: "1px solid var(--kf-border)" }}
            >
              {t("common.close")}
            </button>
            <button
              onClick={handleSaveAttrs}
              disabled={saving || (editReadonly === meta.readonly && (editHidden === meta.isHidden || !IS_WINDOWS))}
              className="px-3 py-1 rounded font-semibold disabled:opacity-40"
              style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
            >
              {saving ? t("properties.saving") : t("properties.changeAttributes")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
