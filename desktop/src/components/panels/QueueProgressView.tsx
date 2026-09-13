import { useTranslation } from "react-i18next";
import type { QueueItem } from "../../store/operationQueueStore";

/**
 * 操作キュー1件ぶんの進捗表示。
 *
 * サイドパネル（OperationQueuePanel）と切り離しウィンドウ（QueueWindowApp）の
 * 両方が同じものを描くため、ここに1つだけ置いて共有する。以前は同じ JSX が
 * 両方にコピーされており、片方だけ直すと表示が食い違う状態だった。
 */

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export default function QueueProgressView({ item }: { item: QueueItem }) {
  const { t } = useTranslation();
  const p = item.progress;
  if (item.status !== "running" || !p) return null;

  // 総バイト数が分かっているとき（通常のコピー、MTP でも端末がサイズを返す場合）。
  if (p.bytesTotal > 0) {
    // 進捗が総量を超えて報告されても 100% で止める（バーがはみ出るのを防ぐ）。
    const pct = Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100));
    return (
      <div className="pl-5 flex flex-col gap-0.5">
        <div
          className="w-full rounded-full overflow-hidden"
          style={{ height: 3, backgroundColor: "var(--kf-border)" }}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, backgroundColor: "var(--kf-accent)", transition: "width 0.1s ease" }}
          />
        </div>
        <div style={{ color: "var(--kf-text-muted)" }}>
          {formatBytes(p.bytesDone)} / {formatBytes(p.bytesTotal)} ({pct}%)
        </div>
      </div>
    );
  }

  // 総バイト数を返さない転送元（一部の MTP 端末）では割合を出せない。
  // 代わりに転送済みバイト数を伸ばしていき、止まっていないことだけは示す。
  if (p.bytesDone > 0) {
    return (
      <div className="pl-5" style={{ color: "var(--kf-text-muted)" }}>
        {t("operationQueue.transferred", { bytes: formatBytes(p.bytesDone) })}
      </div>
    );
  }

  // バイト情報が無く、複数ファイルをまとめて処理している場合の件数表示。
  if (p.total > 1) {
    return (
      <div className="pl-5" style={{ color: "var(--kf-text-muted)" }}>
        {t("operationQueue.fileCount", { current: p.current, total: p.total })}
      </div>
    );
  }

  return null;
}
