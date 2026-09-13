import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { SyncHistoryEntry } from "../../lib/syncHistory";
import Icon from "../common/Icon";

// ── 同期エラーログウィンドウ（?mode=sync-log） ─────────────────────────────
// パネル内の履歴/エラー表示は幅の都合で全文が見られないことがあるため、
// 専用ウィンドウでエラーメッセージを省略なし・選択可能な形で表示する。
// 既定はエラーのみ。トグルで全履歴も見られる。

const PAGE_SIZE = 200;

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function SyncLogWindow() {
  const { t } = useTranslation();
  const [errorsOnly, setErrorsOnly] = useState(true);
  const [entries, setEntries] = useState<SyncHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (offset: number, replace: boolean, onlyErrors: boolean) => {
    setLoading(true);
    try {
      const page = await invoke<{ total: number; entries: SyncHistoryEntry[] }>(
        "load_sync_history", { offset, limit: PAGE_SIZE, errorsOnly: onlyErrors },
      );
      setEntries((prev) => (replace ? page.entries : [...prev, ...page.entries]));
      setTotal(page.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(0, true, errorsOnly);
  }, [errorsOnly, load]);

  const dirLabel: Record<string, string> = {
    download: t("cloudSync.historyDownload"),
    upload: t("cloudSync.historyUpload"),
    deleteLocal: t("cloudSync.historyDeleteLocal"),
    deleteRemote: t("cloudSync.historyDeleteRemote"),
    connect: t("cloudSync.historyConnect"),
    sync: t("cloudSync.historySync"),
  };

  const copyAll = async () => {
    const text = entries
      .map((e) => {
        const head = `[${formatTs(e.ts)}] ${e.status === "error" ? "ERROR" : "OK"} ${dirLabel[e.direction] ?? e.direction} ${e.jobName} (${e.provider}) ${e.name}`;
        return e.error ? `${head}\n  ${e.error}` : head;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div
      className="h-screen flex flex-col"
      style={{ backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-primary)", fontSize: 12 }}
      data-testid="sync-log-window"
    >
      {/* ヘッダー */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="history" size={14} style={{ color: "var(--kf-text-muted)" }} />
        <span className="font-semibold">{t("cloudSync.syncLogWindowTitle")}</span>
        <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>
          {t("cloudSync.historyCount", { shown: entries.length, total })}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-1 cursor-pointer select-none" style={{ fontSize: 11, color: "var(--kf-text-secondary)" }}>
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
            style={{ accentColor: "var(--kf-accent)" }}
          />
          {t("cloudSync.logErrorsOnly")}
        </label>
        <button
          onClick={() => void load(0, true, errorsOnly)}
          title={t("fileList.refresh")}
          className="flex items-center rounded px-1.5 py-0.5"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)" }}
        >
          <Icon name="refresh" size={13} />
        </button>
        <button
          onClick={() => void copyAll()}
          className="flex items-center gap-1 rounded px-2 py-0.5"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)", fontSize: 11 }}
        >
          <Icon name="content_copy" size={12} />
          {copied ? t("cloudSync.logCopied") : t("cloudSync.logCopy")}
        </button>
      </div>

      {/* ログ本文（選択・コピー可能、省略なし） */}
      <div className="flex-1 overflow-y-auto" style={{ userSelect: "text" }}>
        {entries.length === 0 && !loading && (
          <div className="px-4 py-8 text-center" style={{ color: "var(--kf-text-muted)" }}>
            {t("cloudSync.historyEmpty")}
          </div>
        )}
        {entries.map((e, i) => (
          <div
            key={`${e.ts}-${i}`}
            className="px-3 py-2 border-b"
            style={{ borderColor: "var(--kf-border-soft)" }}
          >
            <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 11 }}>
              <Icon
                name={e.status === "error" ? "error" : "check_circle"}
                size={13}
                style={{ color: e.status === "error" ? "#ef4444" : "#22c55e", flexShrink: 0 }}
              />
              <span style={{ color: "var(--kf-text-muted)" }}>{formatTs(e.ts)}</span>
              <span style={{ color: "var(--kf-text-secondary)" }}>{dirLabel[e.direction] ?? e.direction}</span>
              <span style={{ color: "var(--kf-text-muted)" }}>{e.jobName}（{e.provider}）</span>
            </div>
            <div className="mt-0.5" style={{ color: "var(--kf-text-primary)", wordBreak: "break-all" }}>
              {e.name}
            </div>
            {e.error && (
              <pre
                className="mt-1 px-2 py-1.5 rounded whitespace-pre-wrap"
                style={{
                  backgroundColor: "var(--kf-error-bg, rgba(239,68,68,0.08))",
                  color: "#fca5a5",
                  fontSize: 11,
                  fontFamily: "ui-monospace, Consolas, monospace",
                  wordBreak: "break-all",
                  margin: 0,
                }}
              >
                {e.error}
              </pre>
            )}
          </div>
        ))}

        {entries.length < total && (
          <div className="px-3 py-2 text-center">
            <button
              onClick={() => void load(entries.length, false, errorsOnly)}
              disabled={loading}
              className="px-3 py-1 rounded disabled:opacity-40"
              style={{ border: "1px solid var(--kf-border)", color: "var(--kf-accent)", fontSize: 11 }}
            >
              {t("cloudSync.historyLoadMore")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
