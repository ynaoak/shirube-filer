import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { emitTo } from "@tauri-apps/api/event";
import { useSyncJobs } from "../../store/syncStore";
import {
  fetchDiff, downloadSync, uploadSync,
  listRemoteDir, downloadEntry, uploadFileToRemoteDir,
  type SyncDiffItem, type RemoteEntry,
} from "../../lib/cloudSyncEngine";
import { showToast } from "../../lib/toast";
import { createDragGhost, type DragGhost } from "../../lib/dragGhost";
import {
  createCrossWindowDragNotifier, type CrossWindowDragNotifier,
  CLOUD_FILE_DROP_EVENT, type CloudFileDropPayload,
} from "../../lib/tearoff";
import Icon from "../common/Icon";
import ProviderBadge from "./ProviderBadge";
import { providerLabel } from "./providerMeta";
import ToastHost from "../common/ToastHost";

// ── helpers（CloudSyncPanel と同一のフォーマッタ） ─────────────────────
function formatSize(b: number) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

type BrowserState = {
  diff: SyncDiffItem[] | null;
  /** 進行中の操作種別。null = アイドル。どの操作が走っているかをボタン側で
   *  区別して表示する（1 操作の固着で全ボタンが回転し続けないように）。 */
  busy: null | "list" | "diff" | "transfer";
  progress: string;
  errorLines: string[];
};
const defaultState = (): BrowserState => ({ diff: null, busy: null, progress: "", errorLines: [] });

/**
 * クラウドブラウザ専用ウィンドウ。
 * CloudSyncPanel の JobCard に埋め込まれていたリモート操作（差分確認 / ブラウズ /
 * ダウンロード・アップロード）をひとつのウィンドウへ集約する。
 * OS からのファイルドロップでアップロード、行のドラッグでメインウィンドウへの
 * ダウンロードができる。
 */
export default function CloudBrowserWindow({ jobId }: { jobId: string }) {
  const { t } = useTranslation();
  const { jobs, loaded, updateJob } = useSyncJobs();
  const job = jobs.find((j) => j.id === jobId) ?? null;

  // パンくず: 先頭はルート（key=null）。
  const [stack, setStack] = useState<{ key: string | null; label: string }[]>([{ key: null, label: t("cloudSync.root") }]);
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [state, setState] = useState<BrowserState>(defaultState());
  const [dragHover, setDragHover] = useState(false);
  const cur = stack[stack.length - 1];

  const patchState = useCallback((patch: Partial<BrowserState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  // load 等のコールバックが常に最新の job を参照できるように ref で保持する。
  const jobRef = useRef(job);
  useEffect(() => { jobRef.current = job; }, [job]);

  const load = useCallback(async (key: string | null) => {
    const j = jobRef.current;
    if (!j) return;
    patchState({ busy: "list", errorLines: [] });
    try {
      setEntries(await listRemoteDir(j, key));
    } catch (e) {
      patchState({ errorLines: [String(e)] });
      setEntries([]);
    } finally {
      patchState({ busy: null });
    }
  }, [patchState]);

  useEffect(() => {
    if (job) load(cur.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, cur.key, job?.id]);

  const enterDir = (e: RemoteEntry) => setStack((s) => [...s, { key: e.remoteKey, label: e.name }]);
  const goUp = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  // ── 単一ファイルの手動転送 ──────────────────────────────────────────
  const handleDownloadEntry = async (e: RemoteEntry) => {
    const j = jobRef.current;
    if (!j) return;
    if (!j.localPath) { showToast(t("cloudSync.setLocalFirst")); return; }
    patchState({ busy: "transfer", errorLines: [] });
    try {
      await downloadEntry(j, e, j.localPath);
      showToast(t("cloudSync.downloadedFile", { name: e.name }));
    } catch (err) {
      patchState({ errorLines: [String(err)] });
    } finally {
      patchState({ busy: null });
    }
  };

  const handleUploadFile = async () => {
    const j = jobRef.current;
    if (!j) return;
    const p = await openDialog({ multiple: false, directory: false }).catch(() => null);
    if (typeof p !== "string") return;
    patchState({ busy: "transfer", errorLines: [] });
    try {
      await uploadFileToRemoteDir(j, p, cur.key);
      showToast(t("cloudSync.uploadedFile"));
      await load(cur.key);
    } catch (err) {
      patchState({ errorLines: [String(err)] });
    } finally {
      patchState({ busy: null });
    }
  };

  // ── 差分確認・一括ダウンロード/アップロード ────────────────────────
  const handleFetchDiff = async () => {
    const j = jobRef.current;
    if (!j) return;
    patchState({ busy: "diff", diff: null, errorLines: [], progress: t("cloudSync.fetchingDiff") });
    try {
      const diff = await fetchDiff(j);
      patchState({ busy: null, diff, progress: "" });
    } catch (e) {
      patchState({ busy: null, progress: "", errorLines: [String(e)] });
    }
  };

  const handleBulkDownload = async () => {
    const j = jobRef.current;
    const diff = state.diff;
    if (!j || !diff) return;
    const count = diff.filter((d) => d.direction === "download").length;
    if (count === 0) { showToast(t("cloudSync.noDownload")); return; }
    if (!window.confirm(t("cloudSync.confirmDownload", { count }))) return;
    patchState({ busy: "transfer", progress: t("cloudSync.downloading"), errorLines: [] });
    const res = await downloadSync(j, diff, (name, done, total) =>
      patchState({ progress: `${done + 1}/${total}: ${name}` }),
    ).catch((e) => ({ ok: 0, failed: 1, errors: [String(e)] }));
    updateJob(j.id, { lastSyncedAt: Math.floor(Date.now() / 1000) });
    patchState({ busy: null, progress: "", diff: null, errorLines: res.errors });
    showToast(t("cloudSync.downloadDone", { ok: res.ok, failed: res.failed }));
  };

  const handleBulkUpload = async () => {
    const j = jobRef.current;
    const diff = state.diff;
    if (!j || !diff) return;
    const count = diff.filter((d) => d.direction === "upload").length;
    if (count === 0) { showToast(t("cloudSync.noUpload")); return; }
    if (!window.confirm(t("cloudSync.confirmUpload", { count }))) return;
    patchState({ busy: "transfer", progress: t("cloudSync.uploading"), errorLines: [] });
    const res = await uploadSync(j, diff, (name, done, total) =>
      patchState({ progress: `${done + 1}/${total}: ${name}` }),
    ).catch((e) => ({ ok: 0, failed: 1, errors: [String(e)] }));
    updateJob(j.id, { lastSyncedAt: Math.floor(Date.now() / 1000) });
    patchState({ busy: null, progress: "", diff: null, errorLines: res.errors });
    showToast(t("cloudSync.uploadDone", { ok: res.ok, failed: res.failed }));
  };

  // ── D&D アップロード（OS → このウィンドウ） ─────────────────────────
  const uploadPaths = useCallback(async (paths: string[]) => {
    const j = jobRef.current;
    if (!j) return;
    patchState({ busy: "transfer", errorLines: [] });
    const errors: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const name = p.split(/[/\\]/).pop() || p;
      patchState({ progress: t("cloudBrowser.uploadingCount", { current: i + 1, total: paths.length, name }) });
      try {
        await uploadFileToRemoteDir(j, p, cur.key);
      } catch (e) {
        errors.push(String(e));
      }
    }
    patchState({ busy: null, progress: "", errorLines: errors });
    await load(cur.key);
    if (errors.length === 0) showToast(t("cloudSync.uploadedFile"));
  }, [cur.key, load, patchState, t]);

  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const type = e.payload.type;
      if (type === "drop") {
        setDragHover(false);
        if (e.payload.paths.length) void uploadPaths(e.payload.paths);
      } else if (type === "enter" || type === "over") {
        setDragHover(true);
      } else if (type === "leave") {
        setDragHover(false);
      }
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [uploadPaths]);

  // ── D&D ダウンロード（このウィンドウの行 → メインウィンドウ） ───────
  // TabBar のタブドラッグと同じ後始末規律（up/cancel/blur すべてで cleanup）。
  const handleRowPointerDown = (ev: React.PointerEvent, entry: RemoteEntry) => {
    if (ev.button !== 0) return;
    if ((ev.target as HTMLElement).closest("button")) return;

    const startX = ev.clientX;
    const startY = ev.clientY;
    let dragActive = false;
    let ghost: DragGhost | null = null;
    let crossNotifier: CrossWindowDragNotifier | null = null;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      document.body.classList.remove("kf-dragging");
      ghost?.destroy();
      ghost = null;
      crossNotifier?.clear();
      crossNotifier = null;
    };

    const onMove = (me: PointerEvent) => {
      if (!dragActive) {
        if (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5) {
          dragActive = true;
          document.body.classList.add("kf-dragging");
          ghost = createDragGhost(entry.name);
          ghost.move(me.clientX, me.clientY);
          crossNotifier = createCrossWindowDragNotifier(entry.name);
        }
        return;
      }
      ghost?.move(me.clientX, me.clientY);
      const outside =
        me.clientX < 0 || me.clientY < 0 ||
        me.clientX >= window.innerWidth || me.clientY >= window.innerHeight;
      if (outside) crossNotifier?.onMove();
      else crossNotifier?.clear();
    };

    const onCancel = () => cleanup();

    const onUp = (ue: PointerEvent) => {
      const wasDragging = dragActive;
      cleanup();
      if (!wasDragging) return;
      const outside =
        ue.clientX < 0 || ue.clientY < 0 ||
        ue.clientX >= window.innerWidth || ue.clientY >= window.innerHeight;
      if (!outside) return;
      void (async () => {
        try {
          const hit = await invoke<{ label: string | null; x: number; y: number }>(
            "window_at_cursor", { exclude: getCurrentWindow().label },
          );
          if (hit.label && (hit.label === "main" || hit.label.startsWith("main-"))) {
            await emitTo(hit.label, CLOUD_FILE_DROP_EVENT, {
              jobId,
              entry: { name: entry.name, remoteKey: entry.remoteKey, isDir: entry.isDir, size: entry.size },
              cursorX: hit.x,
              cursorY: hit.y,
            } satisfies CloudFileDropPayload);
          }
        } catch { /* ignore */ }
      })();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
  };

  // ── ロード中 / ジョブ未発見 ──────────────────────────────────────────
  if (!loaded) {
    return (
      <div className="flex flex-col h-screen w-screen items-center justify-center text-xs"
        style={{ backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-muted)" }}
      >
        <Icon name="progress_activity" size={24} className="animate-spin" />
      </div>
    );
  }
  if (!job) {
    return (
      <div className="flex flex-col h-screen w-screen items-center justify-center text-xs"
        style={{ backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-muted)" }}
      >
        {t("cloudSync.noJobs")}
      </div>
    );
  }

  const downloadCount = state.diff?.filter((d) => d.direction === "download").length ?? 0;
  const uploadCount = state.diff?.filter((d) => d.direction === "upload").length ?? 0;
  const sameCount = state.diff?.filter((d) => d.direction === "same").length ?? 0;

  return (
    <div className="flex flex-col h-screen w-screen text-xs"
      style={{ backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-primary)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <ProviderBadge provider={job.provider} size={20} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{job.name}</span>
        <span style={{ fontSize: 11, color: "var(--kf-text-muted)" }}>
          {job.provider === "s3" ? t("cloudSync.providerS3Short") : providerLabel(job.provider)}
        </span>
        <span className="flex-1" />
        <span style={{ fontSize: 10, color: "var(--kf-text-muted)" }}>{t("cloudBrowser.dropHint")}</span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b shrink-0" style={{ borderColor: "var(--kf-border)" }}>
        <button onClick={goUp} disabled={stack.length <= 1 || state.busy !== null} className="flex items-center disabled:opacity-30" title={t("cloudSync.up")}>
          <Icon name="arrow_upward" size={16} />
        </button>
        <span className="flex-1 truncate" style={{ fontSize: 11, color: "var(--kf-text-muted)" }} title={stack.map((s) => s.label).join("/")}>
          /{stack.slice(1).map((s) => s.label).join("/")}
        </span>
        <button onClick={() => load(cur.key)} disabled={state.busy !== null} className="flex items-center" title={t("common.update")}>
          <Icon name="refresh" size={16} className={state.busy === "list" ? "animate-spin" : ""} />
        </button>
        <button onClick={handleUploadFile} disabled={state.busy !== null}
          className="flex items-center gap-0.5 px-2 py-0.5 rounded"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-accent)" }}
          title={t("cloudSync.uploadToFolder")}
        >
          <Icon name="upload" size={14} />
        </button>
        <button onClick={handleFetchDiff} disabled={state.busy !== null}
          className="flex items-center gap-0.5 px-2 py-0.5 rounded"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)" }}
          title={t("cloudSync.fetchDiff")}
        >
          <Icon name={state.busy === "diff" ? "progress_activity" : "compare_arrows"} size={14} className={state.busy === "diff" ? "animate-spin" : ""} />
          {t("cloudSync.checkDiff")}
        </button>
      </div>

      {/* Remote file list */}
      <div className="flex-1 overflow-y-auto relative">
        {dragHover && (
          <div className="absolute inset-0 border-2 border-dashed pointer-events-none" style={{ borderColor: "var(--kf-accent)" }} />
        )}
        {entries && entries.length === 0 && state.busy === null && (
          <div className="flex items-center justify-center py-8 text-center" style={{ color: "var(--kf-text-muted)" }}>
            {t("cloudSync.browserEmpty")}
          </div>
        )}
        {entries?.map((e) => (
          <div key={e.remoteKey}
            className="flex items-center py-1 px-3 gap-2 border-b select-none"
            style={{ borderColor: "var(--kf-border-soft)", cursor: e.isDir ? "default" : "grab" }}
            onPointerDown={!e.isDir ? (ev) => handleRowPointerDown(ev, e) : undefined}
          >
            <Icon name={e.isDir ? "folder" : "draft"} size={16} style={{ color: e.isDir ? "var(--kf-accent)" : "var(--kf-text-muted)", flexShrink: 0 }} />
            {e.isDir ? (
              <button onClick={() => enterDir(e)} className="flex-1 truncate text-left" title={e.name}>{e.name}</button>
            ) : (
              <span className="flex-1 truncate" title={e.name}>{e.name}</span>
            )}
            {!e.isDir && (
              <>
                <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>{formatSize(e.size)}</span>
                <button onClick={() => handleDownloadEntry(e)} disabled={state.busy !== null} className="flex items-center" style={{ color: "var(--kf-accent)" }} title={t("cloudSync.downloadToLocal")}>
                  <Icon name="download" size={16} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Diff section（CloudSyncPanel の JobCard から移植） */}
      {state.diff && (
        <div className="max-h-60 overflow-y-auto border-t shrink-0" style={{ borderColor: "var(--kf-border-soft)" }}>
          <div className="flex items-center gap-2 px-2 py-1" style={{ backgroundColor: "var(--kf-bg-secondary)" }}>
            <span className="flex-1" style={{ color: "var(--kf-text-muted)" }}>
              {t("cloudSync.diffSummary", { download: downloadCount, upload: uploadCount, same: sameCount })}
            </span>
            <button
              onClick={handleBulkDownload} disabled={state.busy !== null || downloadCount === 0}
              className="flex items-center gap-0.5 px-2 py-0.5 rounded disabled:opacity-40"
              style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
              title={t("cloudSync.downloadCountTitle", { count: downloadCount })}
            >
              <Icon name="cloud_download" size={12} />
              {downloadCount > 0 ? `↓${downloadCount}` : t("cloudSync.latest")}
            </button>
            <button
              onClick={handleBulkUpload} disabled={state.busy !== null || uploadCount === 0}
              className="flex items-center gap-0.5 px-2 py-0.5 rounded disabled:opacity-40"
              style={{ border: "1px solid var(--kf-accent)", color: "var(--kf-accent)" }}
              title={t("cloudSync.uploadCountTitle", { count: uploadCount })}
            >
              <Icon name="cloud_upload" size={12} />
              {uploadCount > 0 ? `↑${uploadCount}` : t("cloudSync.latest")}
            </button>
          </div>
          {state.diff.filter((d) => d.direction !== "same").map((item) => (
            <div key={item.name}
              className="flex items-center gap-1.5 px-2 py-0.5 border-b"
              style={{ borderColor: "var(--kf-border-soft)" }}
            >
              <Icon
                name={item.direction === "download" ? "cloud_download" : "cloud_upload"}
                size={12}
                style={{ color: item.direction === "download" ? "#60a5fa" : "var(--kf-accent)", flexShrink: 0 }}
              />
              <span className="flex-1 truncate" title={item.name}>{item.name}</span>
              <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>
                {formatSize((item.remote?.size ?? item.local?.size) ?? 0)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Status bar */}
      <div className="border-t px-3 py-1 shrink-0" style={{ borderColor: "var(--kf-border-soft)", fontSize: 10, color: "var(--kf-text-muted)" }}>
        {state.progress && <div className="truncate">{state.progress}</div>}
        {state.errorLines.map((e, i) => <div key={i} className="truncate" style={{ color: "var(--kf-error)" }}>{e}</div>)}
      </div>

      <ToastHost />
    </div>
  );
}
