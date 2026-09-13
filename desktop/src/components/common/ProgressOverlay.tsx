import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../i18n";
import Icon from "./Icon";

type ProgressPayload = {
  current: number;
  total: number;
  file: string;
  done: boolean;
  bytesDone: number;
  bytesTotal: number;
};

type OperationKind = "copy" | "move" | "compress";

type OperationState = {
  kind: OperationKind;
  current: number;
  total: number;
  file: string;
  bytesDone: number;
  bytesTotal: number;
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return i18n.t("progress.etaSeconds", { count: Math.ceil(seconds) });
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return i18n.t("progress.etaMinutes", { m, s });
}

export default function ProgressOverlay() {
  const { t } = useTranslation();
  const [op, setOp] = useState<OperationState | null>(null);
  const startTimeRef = useRef<number>(0);
  const prevBytesRef = useRef<number>(0);
  const speedRef = useRef<number>(0);
  const speedUpdateRef = useRef<number>(0);

  useEffect(() => {
    const handleProgress = (kind: OperationKind) => (event: { payload: ProgressPayload }) => {
      const { current, total, file, done, bytesDone, bytesTotal } = event.payload;

      if (done || total === 0) {
        setOp(null);
        startTimeRef.current = 0;
        return;
      }

      // Initialize start time on first event
      if (startTimeRef.current === 0) {
        startTimeRef.current = Date.now();
        prevBytesRef.current = 0;
        speedRef.current = 0;
      }

      // Update speed every ~500ms using exponential moving average
      const now = Date.now();
      const elapsed = (now - startTimeRef.current) / 1000;
      if (elapsed > 0) {
        const rawSpeed = bytesDone / elapsed;
        // EMA smoothing: 80% old + 20% new
        speedRef.current = speedRef.current === 0
          ? rawSpeed
          : speedRef.current * 0.8 + rawSpeed * 0.2;
      }
      speedUpdateRef.current = now;

      setOp({ kind, current, total, file, bytesDone, bytesTotal });
    };

    const u1 = listen<ProgressPayload>("copy-progress", handleProgress("copy"));
    // ボリューム跨ぎの移動は内部でコピー＋削除になり時間がかかる。中身は
    // コピーと同じだが「移動中」と出したいので別イベントで受ける。
    const u2 = listen<ProgressPayload>("move-progress", handleProgress("move"));
    const u3 = listen<ProgressPayload>("compress-progress", handleProgress("compress"));

    return () => {
      u1.then((fn) => fn());
      u2.then((fn) => fn());
      u3.then((fn) => fn());
    };
  }, []);

  if (!op) return null;

  const pct = op.total > 0 ? Math.round((op.current / op.total) * 100) : 0;
  const bytePct = op.bytesTotal > 0 ? Math.round((op.bytesDone / op.bytesTotal) * 100) : pct;
  // 総バイト数を返さない転送元（一部の MTP 端末）では割合を出せない。
  // 0% のバーが固まって見えるより、転送済みバイト数が伸びるほうが状況が伝わる。
  const sizeUnknown = op.bytesTotal === 0 && op.bytesDone > 0;
  const label = t(
    op.kind === "copy"
      ? "progressOverlay.copying"
      : op.kind === "move"
        ? "progressOverlay.moving"
        : "progressOverlay.compressing"
  );
  const iconName =
    op.kind === "copy" ? "content_copy" : op.kind === "move" ? "drive_file_move" : "folder_zip";
  const speed = speedRef.current;
  const remaining = speed > 0 && op.bytesTotal > op.bytesDone
    ? (op.bytesTotal - op.bytesDone) / speed
    : null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 rounded-lg shadow-xl p-3 text-xs flex flex-col gap-2"
      style={{
        width: 300,
        backgroundColor: "var(--kf-bg-secondary)",
        border: "1px solid var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon name={iconName} size={14} style={{ color: "var(--kf-accent)" }} />
          <span className="font-semibold">{label}</span>
        </div>
        {/* 1 件だけの操作で「0 / 1 件」と出しても情報がなく、しかも実行中は
            ずっと 0 のままで止まって見える。件数は複数のときだけ出す。 */}
        {op.total > 1 && (
          <span style={{ color: "var(--kf-text-muted)" }}>
            {t("progress.countOf", { current: op.current, total: op.total })}
          </span>
        )}
      </div>

      {/* File name */}
      {op.file && (
        <div className="truncate" style={{ color: "var(--kf-text-secondary)" }} title={op.file}>
          {op.file}
        </div>
      )}

      {/* Progress bar */}
      <div>
        {!sizeUnknown && (
          <div
            className="w-full rounded-full overflow-hidden"
            style={{ height: 4, backgroundColor: "var(--kf-border)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${bytePct}%`,
                backgroundColor: "var(--kf-accent)",
                transition: "width 0.1s ease",
              }}
            />
          </div>
        )}
        <div className="flex items-center justify-between mt-0.5" style={{ color: "var(--kf-text-muted)" }}>
          <span>
            {sizeUnknown
              ? t("operationQueue.transferred", { bytes: formatBytes(op.bytesDone) })
              : `${bytePct}%`}
          </span>
          {op.bytesTotal > 0 && (
            <span>{formatBytes(op.bytesDone)} / {formatBytes(op.bytesTotal)}</span>
          )}
        </div>
      </div>

      {/* Speed + ETA */}
      {speed > 0 && (
        <div className="flex items-center justify-between" style={{ color: "var(--kf-text-muted)" }}>
          <span>{formatSpeed(speed)}</span>
          {remaining !== null && <span>{formatEta(remaining)}</span>}
        </div>
      )}

      {/* Cancel button */}
      <button
        onClick={() => invoke("cancel_operation")}
        className="kf-btn kf-btn-secondary self-end"
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}
