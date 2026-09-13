import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";

// ── クラウド同期履歴の記録 ────────────────────────────────────────────────
// 転送のたびに 1 件ずつ書くと I/O が嵩むため、メモリ上のバッファに溜めて
// 1 秒デバウンスでまとめて Rust 側（sync-history.jsonl）へ追記する。
// 保持件数の上限は uiSettings.syncHistoryLimit（既定 10000）。

export type SyncHistoryDirection =
  | "download"
  | "upload"
  | "deleteLocal"
  | "deleteRemote"
  /** OAuth 接続（認証）の失敗など、接続段階のイベント */
  | "connect"
  /** 一覧取得失敗など、ファイル単位に紐付かない同期処理全体のイベント */
  | "sync";

export type SyncHistoryEntry = {
  /** Unix 秒 */
  ts: number;
  jobId: string;
  jobName: string;
  provider: string;
  direction: SyncHistoryDirection;
  /** relPath（リモート/ローカル共通の相対パス） */
  name: string;
  status: "ok" | "error";
  error?: string;
};

let buffer: SyncHistoryEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function historyLimit(): number {
  try {
    const raw = localStorage.getItem("shirube-ui-settings");
    const n = raw ? (JSON.parse(raw) as { syncHistoryLimit?: number }).syncHistoryLimit : undefined;
    return typeof n === "number" && n > 0 ? Math.floor(n) : 10000;
  } catch {
    return 10000;
  }
}

/** 履歴を 1 件バッファに積む（1 秒後にまとめて永続化）。 */
export function recordSyncHistory(entry: SyncHistoryEntry): void {
  buffer.push(entry);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const batch = buffer;
    buffer = [];
    invoke("append_sync_history", { entries: batch, maxEntries: historyLimit() })
      .then(() => listeners.forEach((fn) => fn()))
      .catch(() => { /* 永続化失敗は履歴機能に閉じるため無視 */ });
  }, 1000);
}

/** 履歴が追記された（永続化が完了した）ときの通知を購読する。パネルの再読込用。 */
export function onSyncHistoryAppended(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 同期エラーログウィンドウを開く（既に開いていればフォーカス）。 */
export async function openSyncLogWindow(): Promise<void> {
  const { WebviewWindow, getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
  const label = "sync-log";
  const windows = await getAllWebviewWindows();
  const existing = windows.find((w) => w.label === label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(label, {
    url: `${window.location.origin}/?mode=sync-log`,
    title: i18n.t("cloudSync.syncLogWindowTitle"),
    width: 760,
    height: 560,
    resizable: true,
    center: true,
  });
}
