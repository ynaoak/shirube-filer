import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import Icon from "../common/Icon";

/**
 * EXIF 情報の共有モジュール。
 * PreviewPanel / ImageViewer / QuickPreviewModal から再利用する。
 * 型はバックエンドの Rust `ExifData` 構造体（serde camelCase）のミラー。
 */

/** Rust `ExifData` 構造体のミラー（serde camelCase）。全フィールド optional。 */
export type ExifData = {
  make: string | null;
  model: string | null;
  software: string | null;
  artist: string | null;
  copyright: string | null;
  datetime: string | null;
  datetimeOriginal: string | null;
  datetimeDigitized: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  orientation: number | null;
  exposureTime: string | null;
  fNumber: string | null;
  isoSpeed: number | null;
  focalLength: string | null;
  exposureBias: string | null;
  meteringMode: string | null;
  flash: string | null;
  whiteBalance: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  gpsAltitude: number | null;
};

/** EXIF メタデータを持ち得る画像拡張子。 */
export const EXIF_EXTS = new Set(["jpg", "jpeg", "tif", "tiff", "webp", "heic", "heif", "dng"]);

/** 1 つでも値が入った EXIF フィールドがあれば true。 */
export function hasAnyExif(d: ExifData): boolean {
  return Object.values(d).some((v) => v !== null && v !== undefined && v !== "");
}

/** 値が入っている EXIF フィールドをラベル付きの表として描画する（GPS は地図リンク付き）。 */
export function ExifTable({ data }: { data: ExifData }) {
  const { t } = useTranslation();
  const fmtCoord = (lat: number, lon: number) =>
    `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

  // [label, value] のペア。空フィールドはスキップ。
  const rows: Array<[string, string]> = [];
  const push = (label: string, v: string | number | null | undefined) => {
    if (v !== null && v !== undefined && v !== "") rows.push([label, String(v)]);
  };

  push(t("exif.camera"), [data.make, data.model].filter(Boolean).join(" "));
  push(t("exif.software"), data.software);
  push(t("exif.datetime"), data.datetimeOriginal ?? data.datetime);
  if (data.imageWidth && data.imageHeight) {
    push(t("exif.resolution"), `${data.imageWidth} × ${data.imageHeight}`);
  }
  push(t("exif.aperture"), data.fNumber);
  push(t("exif.shutterSpeed"), data.exposureTime);
  push(t("exif.iso"), data.isoSpeed);
  push(t("exif.focalLength"), data.focalLength);
  push(t("exif.exposureBias"), data.exposureBias);
  push(t("exif.meteringMode"), data.meteringMode);
  push(t("exif.flash"), data.flash);
  push(t("exif.whiteBalance"), data.whiteBalance);
  push(t("exif.artist"), data.artist);
  push(t("exif.copyright"), data.copyright);
  if (data.gpsAltitude != null) push(t("exif.altitude"), `${data.gpsAltitude.toFixed(1)} m`);

  const hasGps = data.gpsLatitude != null && data.gpsLongitude != null;

  return (
    <div
      className="mx-2 mb-2 rounded border text-[10px]"
      style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1 border-b"
        style={{ borderColor: "var(--kf-border-soft)", color: "var(--kf-text-muted)" }}
      >
        <Icon name="info" size={12} />
        <span className="font-semibold">{t("preview.exifInfo")}</span>
      </div>
      <table className="w-full" style={{ borderCollapse: "collapse" }}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} style={{ borderBottom: "1px solid var(--kf-border-soft)" }}>
              <td
                className="px-2 py-0.5 align-top whitespace-nowrap"
                style={{ color: "var(--kf-text-muted)", width: "40%" }}
              >
                {label}
              </td>
              <td className="px-2 py-0.5 break-all" style={{ color: "var(--kf-text-primary)" }}>
                {value}
              </td>
            </tr>
          ))}
          {hasGps && (
            <tr>
              <td
                className="px-2 py-0.5 align-top whitespace-nowrap"
                style={{ color: "var(--kf-text-muted)" }}
              >
                GPS
              </td>
              <td className="px-2 py-0.5" style={{ color: "var(--kf-text-primary)" }}>
                <div className="break-all">{fmtCoord(data.gpsLatitude!, data.gpsLongitude!)}</div>
                <button
                  onClick={() =>
                    openUrl(
                      `https://www.openstreetmap.org/?mlat=${data.gpsLatitude}&mlon=${data.gpsLongitude}#map=15/${data.gpsLatitude}/${data.gpsLongitude}`
                    ).catch(() => {})
                  }
                  className="flex items-center gap-1 mt-0.5 hover:opacity-80"
                  style={{ color: "var(--kf-accent)" }}
                >
                  <Icon name="map" size={11} />
                  {t("exif.openMap")}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
