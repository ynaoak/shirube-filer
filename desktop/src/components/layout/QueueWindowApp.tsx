import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../common/Icon";
import { QueueItem, QueueItemStatus } from "../../store/operationQueueStore";
import QueueProgressView from "../panels/QueueProgressView";

type QueueState = { items: QueueItem[]; paused: boolean };
type QueueMsg =
  | { type: "state"; items: QueueItem[]; paused: boolean }
  | { type: "request-state" };
type QueueCmd = { type: "cmd"; action: "cancel" | "retry" | "clear" | "pause" | "resume"; id?: string };

const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kf-queue") : null;

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
      return <Icon name="smartphone" size={11} style={{ color: "var(--kf-text-muted)" }} />;
  }
}

export default function QueueWindowApp() {
  const { t } = useTranslation();
  const [state, setState] = useState<QueueState>({ items: [], paused: false });

  useEffect(() => {
    if (!bc) return;
    const handler = (e: MessageEvent<QueueMsg>) => {
      if (e.data?.type === "state") {
        setState({ items: e.data.items, paused: e.data.paused });
      }
    };
    bc.addEventListener("message", handler);
    // Request current state from main window
    bc.postMessage({ type: "request-state" } satisfies QueueMsg);
    return () => bc.removeEventListener("message", handler);
  }, []);

  const sendCmd = useCallback((action: QueueCmd["action"], id?: string) => {
    bc?.postMessage({ type: "cmd", action, id } satisfies QueueCmd);
  }, []);

  // Escape キーでウィンドウを閉じる
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      getCurrentWindow().close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const { items, paused } = state;
  const pendingCount = items.filter((i) => i.status === "pending").length;
  const runningCount = items.filter((i) => i.status === "running").length;
  const errorCount = items.filter((i) => i.status === "error").length;
  const doneCount = items.filter((i) => i.status === "done" || i.status === "cancelled").length;

  return (
    <div
      className="flex flex-col w-full h-full text-xs overflow-hidden"
      style={{
        backgroundColor: "var(--kf-bg-secondary)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-1.5 px-3 py-2 shrink-0 border-b"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="queue" size={13} style={{ color: "var(--kf-accent)" }} />
        <span className="font-semibold flex-1">{t("operationQueue.title")}</span>
        <button
          title={paused ? t("operationQueue.resume") : t("operationQueue.pause")}
          onClick={() => sendCmd(paused ? "resume" : "pause")}
          className="opacity-60 hover:opacity-100"
        >
          <Icon name={paused ? "play_arrow" : "pause"} size={14} />
        </button>
        {doneCount > 0 && (
          <button
            title={t("operationQueue.clearCompleted")}
            onClick={() => sendCmd("clear")}
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
            {items.map((item) => {
              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-1 px-3 py-2 border-b"
                  style={{ borderColor: "var(--kf-border)" }}
                >
                  <div className="flex items-center gap-1.5">
                    <StatusIcon status={item.status} />
                    <OpIcon type={item.op.type} />
                    <span className="flex-1 truncate" title={item.label}>{item.label}</span>
                    {(item.status === "pending" || item.status === "running") && (
                      <button
                        onClick={() => sendCmd("cancel", item.id)}
                        className="opacity-50 hover:opacity-100 shrink-0"
                        title={t("operationQueue.cancel")}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                    {(item.status === "error" || item.status === "cancelled") && (
                      <button
                        onClick={() => sendCmd("retry", item.id)}
                        className="opacity-50 hover:opacity-100 shrink-0"
                        title={t("operationQueue.retry")}
                      >
                        <Icon name="refresh" size={12} />
                      </button>
                    )}
                  </div>
                  <div className="truncate pl-5" style={{ color: "var(--kf-text-muted)" }}>
                    {item.groupLabel}
                  </div>
                  <QueueProgressView item={item} />
                  {item.status === "error" && item.error && (
                    <div className="pl-5 truncate" style={{ color: "var(--kf-error)" }} title={item.error}>
                      {item.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
