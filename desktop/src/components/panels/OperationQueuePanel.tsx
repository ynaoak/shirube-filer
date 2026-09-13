import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../common/Icon";
import { useOperationQueue, QueueItem, QueueItemStatus } from "../../store/operationQueueStore";
import QueueProgressView from "./QueueProgressView";

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 280;

function StatusIcon({ status }: { status: QueueItemStatus }) {
  switch (status) {
    case "pending":
      return <Icon name="schedule" size={13} style={{ color: "var(--kf-text-muted)" }} />;
    case "running":
      return <Icon name="sync" size={13} style={{ color: "var(--kf-accent)", animation: "spin 1s linear infinite" }} />;
    case "done":
      return <Icon name="check_circle" size={13} style={{ color: "var(--kf-success)" }} />;
    case "error":
      return <Icon name="error" size={13} style={{ color: "var(--kf-error)" }} />;
    case "cancelled":
      return <Icon name="cancel" size={13} style={{ color: "var(--kf-text-muted)" }} />;
  }
}

function OpIcon({ type }: { type: QueueItem["op"]["type"] }) {
  switch (type) {
    case "copy":
      return <Icon name="content_copy" size={11} style={{ color: "var(--kf-text-muted)" }} />;
    case "move":
      return <Icon name="drive_file_move" size={11} style={{ color: "var(--kf-text-muted)" }} />;
    case "delete":
      return <Icon name="delete" size={11} style={{ color: "var(--kf-text-muted)" }} />;
    case "mtpDownload":
      // MTP（スマホ等）からの取り出しはコピーだが、端末からの取得と分かるよう
      // 別アイコンにする。
      return <Icon name="smartphone" size={11} style={{ color: "var(--kf-text-muted)" }} />;
  }
}

export default function OperationQueuePanel() {
  const { t } = useTranslation();
  const { items, paused, cancelItem, retryItem, clearCompleted, setPaused } = useOperationQueue();
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onMouseDownResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      const newW = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragRef.current.startW + delta));
      setWidth(newW);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const runningCount = items.filter((i) => i.status === "running").length;
  const errorCount = items.filter((i) => i.status === "error").length;
  const doneCount = items.filter((i) => i.status === "done" || i.status === "cancelled").length;

  return (
    <div
      className="flex shrink-0 border-l relative"
      style={{
        width,
        borderColor: "var(--kf-border)",
        backgroundColor: "var(--kf-bg-secondary)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 z-10"
        style={{ cursor: "col-resize" }}
        onMouseDown={onMouseDownResize}
      />

      <div className="flex flex-col w-full text-xs overflow-hidden">
        {/* Header */}
        <div
          className="flex items-center gap-1.5 px-3 py-2 shrink-0 border-b"
          style={{ borderColor: "var(--kf-border)" }}
        >
          <Icon name="queue" size={13} style={{ color: "var(--kf-accent)" }} />
          <span className="font-semibold flex-1">{t("operationQueue.title")}</span>
          <button
            title={paused ? t("operationQueue.resume") : t("operationQueue.pause")}
            onClick={() => setPaused(!paused)}
            className="opacity-60 hover:opacity-100"
          >
            <Icon name={paused ? "play_arrow" : "pause"} size={14} />
          </button>
          {doneCount > 0 && (
            <button
              title={t("operationQueue.clearCompleted")}
              onClick={clearCompleted}
              className="opacity-60 hover:opacity-100"
            >
              <Icon name="clear_all" size={14} />
            </button>
          )}
        </div>

        {/* Summary bar */}
        {items.length > 0 && (
          <div
            className="flex items-center gap-3 px-3 py-1.5 shrink-0 border-b"
            style={{ borderColor: "var(--kf-border)", color: "var(--kf-text-muted)" }}
          >
            {pendingCount > 0 && <span>{t("operationQueue.pending", { count: pendingCount })}</span>}
            {runningCount > 0 && <span style={{ color: "var(--kf-accent)" }}>{t("operationQueue.running")}</span>}
            {errorCount > 0 && <span style={{ color: "var(--kf-error)" }}>{t("operationQueue.error", { count: errorCount })}</span>}
            {doneCount > 0 && <span>{t("operationQueue.done", { count: doneCount })}</span>}
            {paused && <span style={{ color: "var(--kf-warning)" }}>{t("operationQueue.paused")}</span>}
          </div>
        )}

        {/* Items list */}
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center h-full gap-2"
              style={{ color: "var(--kf-text-muted)" }}
            >
              <Icon name="check_circle" size={32} />
              <span>{t("operationQueue.empty")}</span>
            </div>
          ) : (
            <div className="flex flex-col">
              {items.map((item) => (
                <QueueItemRow
                  key={item.id}
                  item={item}
                  onCancel={cancelItem}
                  onRetry={retryItem}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueItemRow({
  item,
  onCancel,
  onRetry,
}: {
  item: QueueItem;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-col gap-1 px-3 py-2 border-b"
      style={{ borderColor: "var(--kf-border)" }}
    >
      {/* Row header */}
      <div className="flex items-center gap-1.5">
        <StatusIcon status={item.status} />
        <OpIcon type={item.op.type} />
        <span className="flex-1 truncate" title={item.label}>
          {item.label}
        </span>
        {(item.status === "pending" || item.status === "running") && (
          <button
            onClick={() => onCancel(item.id)}
            className="opacity-50 hover:opacity-100 shrink-0"
            title={t("operationQueue.cancel")}
          >
            <Icon name="close" size={12} />
          </button>
        )}
        {(item.status === "error" || item.status === "cancelled") && (
          <button
            onClick={() => onRetry(item.id)}
            className="opacity-50 hover:opacity-100 shrink-0"
            title={t("operationQueue.retry")}
          >
            <Icon name="refresh" size={12} />
          </button>
        )}
      </div>

      {/* Group label */}
      <div className="truncate pl-5" style={{ color: "var(--kf-text-muted)" }}>
        {item.groupLabel}
      </div>

      {/* Progress (byte bar / transferred bytes / file count) */}
      <QueueProgressView item={item} />

      {/* Error message */}
      {item.status === "error" && item.error && (
        <div className="pl-5 truncate" style={{ color: "var(--kf-error)" }} title={item.error}>
          {item.error}
        </div>
      )}
    </div>
  );
}
