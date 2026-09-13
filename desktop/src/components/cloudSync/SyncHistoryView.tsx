import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { onSyncHistoryAppended, openSyncLogWindow } from "../../lib/syncHistory";
import type { SyncHistoryEntry } from "../../lib/syncHistory";
import Icon from "../common/Icon";

// ── 同期履歴ビュー ────────────────────────────────────────────────────────
// CloudSyncPanel 内に表示するスクロール可能な履歴一覧。新しい順に
// ページ読み込みし、末尾の「さらに読み込む」で追加取得する。
// 同期が走って履歴が追記されたら先頭ページを自動で再読込する。

const PAGE_SIZE = 100;

const DIRECTION_ICON: Record<SyncHistoryEntry["direction"], string> = {
  download: "download",
  upload: "upload",
  deleteLocal: "delete",
  deleteRemote: "delete",
  connect: "link",
  sync: "sync",
};

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function SyncHistoryView() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<SyncHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const page = await invoke<{ total: number; entries: SyncHistoryEntry[] }>(
        "load_sync_history", { offset: 0, limit: PAGE_SIZE },
      );
      setEntries(page.entries);
      setTotal(page.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const page = await invoke<{ total: number; entries: SyncHistoryEntry[] }>(
        "load_sync_history", { offset: entries.length, limit: PAGE_SIZE },
      );
      setEntries((prev) => [...prev, ...page.entries]);
      setTotal(page.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, [entries.length]);

  useEffect(() => {
    void loadFirstPage();
    // 同期で履歴が追記されたら先頭ページを再読込
    return onSyncHistoryAppended(() => { void loadFirstPage(); });
  }, [loadFirstPage]);

  const dirLabel: Record<SyncHistoryEntry["direction"], string> = {
    download: t("cloudSync.historyDownload"),
    upload: t("cloudSync.historyUpload"),
    deleteLocal: t("cloudSync.historyDeleteLocal"),
    deleteRemote: t("cloudSync.historyDeleteRemote"),
    connect: t("cloudSync.historyConnect"),
    sync: t("cloudSync.historySync"),
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="sync-history-view">
      {/* 件数ヘッダー */}
      <div
        className="flex items-center gap-2 px-3 py-1 border-b shrink-0"
        style={{ borderColor: "var(--kf-border-soft)", color: "var(--kf-text-muted)", fontSize: 10 }}
      >
        <Icon name="history" size={11} />
        <span className="flex-1">{t("cloudSync.historyCount", { shown: entries.length, total })}</span>
        {/* 全文が見られる専用ウィンドウを開く（パネル内は幅の都合で省略表示のため） */}
        <button
          onClick={() => void openSyncLogWindow()}
          title={t("cloudSync.historyOpenLog")}
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:opacity-80"
          style={{ color: "var(--kf-accent)" }}
        >
          <Icon name="open_in_new" size={11} />
          <span>{t("cloudSync.historyOpenLog")}</span>
        </button>
      </div>

      {/* スクロール一覧 */}
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 && !loading && (
          <div className="px-3 py-6 text-center" style={{ color: "var(--kf-text-muted)", fontSize: 11 }}>
            {t("cloudSync.historyEmpty")}
          </div>
        )}
        {entries.map((e, i) => (
          <div
            key={`${e.ts}-${i}`}
            className="flex items-center gap-2 px-3 py-1 border-b"
            style={{
              borderColor: "var(--kf-border-weak, var(--kf-border-soft))", fontSize: 11,
              cursor: e.status === "error" ? "pointer" : undefined,
            }}
            title={e.status === "error" ? e.error : undefined}
            // エラー行はクリックで全文表示のログウィンドウを開く
            onClick={e.status === "error" ? () => void openSyncLogWindow() : undefined}
          >
            <Icon
              name={e.status === "error" ? "error" : DIRECTION_ICON[e.direction]}
              size={13}
              style={{ color: e.status === "error" ? "#ef4444" : "var(--kf-text-muted)", flexShrink: 0 }}
            />
            <div className="flex-1 min-w-0">
              <div
                className="truncate"
                style={{ color: e.status === "error" ? "#ef4444" : "var(--kf-text-primary)" }}
              >
                {e.name}
              </div>
              <div className="flex items-center gap-2" style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>
                <span>{formatTs(e.ts)}</span>
                <span>{dirLabel[e.direction] ?? e.direction}</span>
                <span className="truncate">{e.jobName}</span>
              </div>
            </div>
          </div>
        ))}

        {/* さらに読み込む */}
        {entries.length < total && (
          <div className="px-3 py-2 text-center">
            <button
              onClick={() => void loadMore()}
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
