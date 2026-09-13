// ファイルサイズ・日時のフォーマット関数。
import i18n from "../../i18n";

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatDateAbsolute(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatDateRelative(ts: number): string {
  const diffSec = Math.floor(Date.now() / 1000) - ts;
  if (diffSec < 60) return i18n.t("fileList.timeJustNow");
  if (diffSec < 3600) return i18n.t("fileList.timeMinutesAgo", { count: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return i18n.t("fileList.timeHoursAgo", { count: Math.floor(diffSec / 3600) });
  if (diffSec < 86400 * 7) return i18n.t("fileList.timeDaysAgo", { count: Math.floor(diffSec / 86400) });
  if (diffSec < 86400 * 30) return i18n.t("fileList.timeWeeksAgo", { count: Math.floor(diffSec / (86400 * 7)) });
  if (diffSec < 86400 * 365) return i18n.t("fileList.timeMonthsAgo", { count: Math.floor(diffSec / (86400 * 30)) });
  return i18n.t("fileList.timeYearsAgo", { count: Math.floor(diffSec / (86400 * 365)) });
}

export function formatDate(ts: number | null, relative: boolean): string {
  if (!ts) return "";
  return relative ? formatDateRelative(ts) : formatDateAbsolute(ts);
}
