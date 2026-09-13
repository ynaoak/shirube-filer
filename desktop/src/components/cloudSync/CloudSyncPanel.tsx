import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSyncJobs, newSyncJob, type CloudSyncJob, type SyncProvider } from "../../store/syncStore";
import { runAutoSync, startOauthConnect, cancelOauthConnect, clearTokenCache } from "../../lib/cloudSyncEngine";
import { openCloudBrowserWindow } from "../../lib/cloudBrowser";
import SyncHistoryView from "./SyncHistoryView";
import { recordSyncHistory, openSyncLogWindow } from "../../lib/syncHistory";
import type { SyncMode } from "../../store/syncStore";
import { showToast } from "../../lib/toast";
import Icon from "../common/Icon";
import ProviderBadge from "./ProviderBadge";
import { isOauth, methodLabelKey, providerLabel } from "./providerMeta";
import ConnectionSettingsDialog from "./ConnectionSettingsDialog";
import { confirmConnectionRemoval } from "./confirmConnectionRemoval";

const SYNC_MODE_KEY: Record<SyncMode, string> = {
  download: "cloudSync.modeDownloadShort",
  upload: "cloudSync.modeUploadShort",
  bidirectional: "cloudSync.modeBidirectionalShort",
};

// グループの折りたたみ状態を保存する localStorage キー（JSON 文字列配列）。
// 未分類グループは "" をキーとして扱う。
const COLLAPSED_GROUPS_KEY = "kf-sync-groups-collapsed";

// ── helpers ──────────────────────────────────────────────────────────
function formatTs(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type JobState = {
  loading: boolean;
  progress: string;
  errorLines: string[];
};
const defaultJobState = (): JobState => ({ loading: false, progress: "", errorLines: [] });

// ── component ────────────────────────────────────────────────────────
type Props = {
  /** パネル右上の × から閉じる（ActivityBar のトグルと同じ導線） */
  onClose?: () => void;
};

export default function CloudSyncPanel({ onClose }: Props = {}) {
  const { t } = useTranslation();
  const { jobs, loaded, addJob, updateJob, removeJob, moveJob } = useSyncJobs();
  const [state, setState] = useState<Record<string, JobState>>({});
  const pollingRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // 接続設定ポップアップを開いているジョブの id（null = 非表示）。
  const [settingsJobId, setSettingsJobId] = useState<string | null>(null);

  // 同期履歴ビューの表示（接続一覧と切り替え）。
  const [showHistory, setShowHistory] = useState(false);

  // 検索
  const [query, setQuery] = useState("");

  // ストレージ種類（プロバイダ）での絞り込み。"" = すべて。
  const [providerFilter, setProviderFilter] = useState<SyncProvider | "">("");

  // ドラッグ＆ドロップ並べ替えの状態。
  // dragId: ドラッグ中のジョブ id / dropPos: ドロップ先（前/後）のインジケータ。
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<{ id: string; before: boolean } | null>(null);

  // グループの折りたたみ状態（localStorage に永続化）。
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const toggleCollapsed = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(key) ? prev.filter((g) => g !== key) : [...prev, key];
      try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // グループ名のインライン編集
  const [renaming, setRenaming] = useState<{ group: string; value: string } | null>(null);
  const commitRename = () => {
    if (!renaming) return;
    const oldName = renaming.group;
    const newName = renaming.value.trim();
    setRenaming(null);
    if (newName === oldName) return;
    for (const j of jobs) {
      if (j.group === oldName) updateJob(j.id, { group: newName || undefined });
    }
  };
  const handleUngroup = (name: string) => {
    if (!window.confirm(t("cloudSync.ungroupConfirm", { name }))) return;
    for (const j of jobs) {
      if (j.group === name) updateJob(j.id, { group: undefined });
    }
  };

  const patchState = useCallback((id: string, patch: Partial<JobState>) => {
    setState((prev) => ({ ...prev, [id]: { ...defaultJobState(), ...prev[id], ...patch } }));
  }, []);

  // ── auto-sync polling ──────────────────────────────────────────────
  // 最新の jobs を ref で参照することで、setInterval のコールバックが古い
  // スナップショットを掴むのを防ぐ（特に runAuto 完了時の updateJob でも
  // useEffect が再実行されないようスケジュール キーを安定化）。
  const jobsRef = useRef(jobs);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  // syncMode に応じて download / upload / bidirectional を自動実行する。
  // 引数の jobId から jobsRef で最新の job を引き、設定変更後も次回ポーリングで反映する。
  const runAuto = useCallback(async (jobId: string) => {
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job || !job.enabled || job.autoDownloadInterval === 0) return;
    try {
      const res = await runAutoSync(job);
      const patch: Partial<CloudSyncJob> = { lastSyncedAt: Math.floor(Date.now() / 1000) };
      if (res.nextSnapshot) patch.lastSyncedPaths = res.nextSnapshot;
      if (res.ok > 0) {
        showToast(t("cloudSync.autoSyncDone", { name: job.name, mode: t(SYNC_MODE_KEY[job.syncMode]), count: res.ok }));
      }
      // 削除反映スナップショットは ok===0 でも更新する（次回の削除検出基準のため）。
      updateJob(job.id, patch);
    } catch (e) {
      // ポーリング失敗でユーザーを中断しない（トーストは出さない）が、
      // 原因調査のためエラーログには残す（同期エラーログウィンドウで閲覧可能）。
      recordSyncHistory({
        ts: Math.floor(Date.now() / 1000),
        jobId: job.id, jobName: job.name, provider: job.provider,
        direction: "sync", name: job.name, status: "error", error: String(e),
      });
      patchState(job.id, { errorLines: [String(e)] });
    }
  }, [updateJob]);

  // ポーリングのスケジュールに使う安定キー: id|enabled|interval のみで構成する。
  // 内容（パスワード等）の更新で再スケジュールしない（runAuto は ref で最新を引く）。
  const scheduleKey = jobs
    .map((j) => `${j.id}:${j.enabled ? 1 : 0}:${j.autoDownloadInterval}`)
    .join(",");

  useEffect(() => {
    // ポーリングを張り直す（スケジュール対象が変わったときだけ）
    Object.values(pollingRefs.current).forEach(clearInterval);
    pollingRefs.current = {};
    for (const job of jobsRef.current) {
      if (job.enabled && job.autoDownloadInterval > 0) {
        // 1回即時
        runAuto(job.id);
        pollingRefs.current[job.id] = setInterval(
          () => runAuto(job.id),
          job.autoDownloadInterval * 60 * 1000,
        );
      }
    }
    return () => { Object.values(pollingRefs.current).forEach(clearInterval); };
  }, [scheduleKey, runAuto]);

  // ── handlers ────────────────────────────────────────────────────────
  const handleAdd = (provider: SyncProvider) => {
    const j = newSyncJob(provider);
    addJob(j);
    // 新規接続はそのまま設定ポップアップへ（従来はパネル内展開だった）。
    setSettingsJobId(j.id);
  };

  // OAuth プロバイダ（box/dropbox/gcs/gdrive/onedrive）の認証。ブラウザが開く。
  const handleConnect = async (job: CloudSyncJob) => {
    patchState(job.id, { loading: true, progress: t("cloudSync.authorizingBrowser"), errorLines: [] });
    try {
      const refreshToken = await startOauthConnect(job.provider);
      clearTokenCache(job.id);
      const cur = (job as unknown as Record<string, Record<string, unknown> | undefined>)[job.provider] ?? {};
      updateJob(job.id, { [job.provider]: { ...cur, refreshToken } } as Partial<CloudSyncJob>);
      patchState(job.id, { loading: false, progress: "" });
      showToast(t("cloudSync.connected", { provider: providerLabel(job.provider) }));
    } catch (e) {
      // ユーザー自身が「キャンセル」した場合はエラー扱いにしない
      const msg = String(e);
      const cancelled = msg.includes("キャンセルしました");
      if (!cancelled) {
        recordSyncHistory({
          ts: Math.floor(Date.now() / 1000),
          jobId: job.id, jobName: job.name, provider: job.provider,
          direction: "connect", name: job.name, status: "error", error: msg,
        });
      }
      patchState(job.id, {
        loading: false, progress: "",
        errorLines: cancelled ? [] : [msg],
      });
    }
  };

  // 認証待ちの中断。待機中の startOauthConnect が reject され、上の catch で loading が解除される。
  const handleCancelConnect = (job: CloudSyncJob) => {
    void cancelOauthConnect(job.provider).catch(() => {});
  };

  // クラウドブラウザウィンドウを開く（差分確認・ブラウズ・転送はすべてこちらへ移動済み）。
  // 実体は共有ヘルパー（ActivityBar のダイレクトアイコンと共用）。
  const openCloudBrowser = useCallback(async (job: CloudSyncJob) => {
    await openCloudBrowserWindow(job);
  }, []);

  // ── 検索・絞り込み・グループ分け ────────────────────────────────────
  const q = query.trim().toLowerCase();
  const matchesQuery = (j: CloudSyncJob) => {
    if (!q) return true;
    return (
      j.name.toLowerCase().includes(q) ||
      providerLabel(j.provider).toLowerCase().includes(q) ||
      (j.group ?? "").toLowerCase().includes(q)
    );
  };
  // 絞り込み候補: 登録済みジョブに存在するプロバイダのみ（初出順、件数付き）。
  const usedProviders: SyncProvider[] = [];
  for (const j of jobs) {
    if (!usedProviders.includes(j.provider)) usedProviders.push(j.provider);
  }
  // 選択中の種類のジョブが全て削除された場合は「すべて」に戻す。
  const activeFilter = providerFilter !== "" && usedProviders.includes(providerFilter) ? providerFilter : "";

  const filtered = jobs.filter(
    (j) => (activeFilter === "" || j.provider === activeFilter) && matchesQuery(j),
  );
  const searching = q !== "" || activeFilter !== "";

  // グループ一覧（初出順）。表示中（フィルタ後）のジョブに存在するグループのみ。
  const groupNames: string[] = [];
  for (const j of filtered) {
    if (j.group && !groupNames.includes(j.group)) groupNames.push(j.group);
  }
  const ungrouped = filtered.filter((j) => !j.group);

  // ダイアログのグループ候補（全ジョブから、初出順）。
  const existingGroups: string[] = [];
  for (const j of jobs) {
    if (j.group && !existingGroups.includes(j.group)) existingGroups.push(j.group);
  }

  const settingsJob = jobs.find((j) => j.id === settingsJobId) ?? null;

  // ── ドラッグ＆ドロップ並べ替え ──────────────────────────────────────
  const handleDropOn = (target: CloudSyncJob) => {
    const srcId = dragId;
    const pos = dropPos;
    setDragId(null);
    setDropPos(null);
    if (!srcId || !pos || srcId === target.id || pos.id !== target.id) return;
    const src = jobs.find((j) => j.id === srcId);
    if (!src) return;
    moveJob(srcId, target.id, pos.before);
    // グループ表示中に別グループのカードへドロップした場合はそのグループへ移す
    // （グループ未使用時は双方 undefined のため no-op）。
    if ((src.group ?? "") !== (target.group ?? "")) {
      updateJob(srcId, { group: target.group });
    }
  };

  const renderJobCard = (job: CloudSyncJob) => {
    const s = { ...defaultJobState(), ...state[job.id] };
    return (
      <JobCard
        key={job.id}
        job={job}
        s={s}
        onChange={(patch) => updateJob(job.id, patch)}
        onRemove={() => confirmConnectionRemoval(
          t("cloudSync.confirmDelete", { name: job.name }),
          () => removeJob(job.id),
        )}
        onOpenSettings={() => setSettingsJobId(job.id)}
        onOpenBrowser={() => openCloudBrowser(job)}
        dragging={dragId === job.id}
        dropIndicator={dropPos?.id === job.id ? (dropPos.before ? "top" : "bottom") : null}
        onDragStart={() => setDragId(job.id)}
        onDragEnd={() => { setDragId(null); setDropPos(null); }}
        onDragOverCard={(before) => {
          if (!dragId || dragId === job.id) return;
          setDropPos((prev) =>
            prev?.id === job.id && prev.before === before ? prev : { id: job.id, before },
          );
        }}
        onDropCard={() => handleDropOn(job)}
      />
    );
  };

  // グループヘッダー行（折りたたみ・改名・グループ解除）。未分類は key="" で扱う。
  const renderGroupHeader = (key: string, label: string, count: number) => {
    const isReal = key !== "";
    const collapsed = !searching && collapsedGroups.includes(key);
    const isRenaming = renaming?.group === key;
    return (
      <div
        key={`group-${key || "ungrouped"}`}
        className="flex items-center gap-1 px-2 py-1 border-b"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border-soft)" }}
      >
        <button onClick={() => toggleCollapsed(key)} className="flex items-center flex-shrink-0">
          <Icon name={collapsed ? "chevron_right" : "expand_more"} size={16} />
        </button>
        {isRenaming ? (
          <input
            autoFocus
            value={renaming!.value}
            onChange={(e) => setRenaming({ group: key, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={commitRename}
            className="flex-1 min-w-0 bg-transparent outline-none px-1 py-0.5 rounded"
            style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)", fontSize: 11 }}
          />
        ) : (
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--kf-text-muted)" }}>{label}</span>
        )}
        <span style={{ fontSize: 10, color: "var(--kf-text-muted)" }}>({count})</span>
        <span className="flex-1" />
        {isReal && (
          <button
            onClick={() => setRenaming({ group: key, value: key })}
            className="p-1 rounded hover:opacity-100 opacity-80 flex items-center flex-shrink-0"
            title={t("cloudSync.renameGroup")}
          >
            <Icon name="edit" size={18} style={{ color: "var(--kf-accent)" }} />
          </button>
        )}
        {isReal && (
          <button
            onClick={() => handleUngroup(key)}
            className="p-1 rounded hover:opacity-100 opacity-80 flex items-center flex-shrink-0"
            title={t("cloudSync.ungroup")}
          >
            <Icon name="label_off" size={18} style={{ color: "var(--kf-warning)" }} />
          </button>
        )}
      </div>
    );
  };

  // ── render ───────────────────────────────────────────────────────────
  return (
    <div
      className="w-80 flex-shrink-0 flex flex-col border-l text-xs overflow-hidden"
      style={{ backgroundColor: "var(--kf-bg-primary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="cloud" size={14} style={{ color: "var(--kf-text-muted)" }} />
        <span className="font-semibold flex-1 whitespace-nowrap">{t("cloudSync.title")}</span>
        <button
          onClick={() => setShowHistory((v) => !v)}
          title={t("cloudSync.historyTitle")}
          className="flex items-center rounded px-1 py-0.5"
          style={{
            color: showHistory ? "var(--kf-accent)" : "var(--kf-text-muted)",
            border: `1px solid ${showHistory ? "var(--kf-accent)" : "transparent"}`,
          }}
        >
          <Icon name="history" size={14} />
        </button>
        <select
          value=""
          onChange={(e) => { if (e.target.value) handleAdd(e.target.value as SyncProvider); e.target.value = ""; }}
          className="bg-transparent outline-none rounded px-1 py-0.5 text-xs"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-accent)", maxWidth: 96 }}
        >
          <option value="">{t("cloudSync.addOption")}</option>
          <option value="s3">{t("cloudSync.providerS3")}</option>
          <option value="azblob">Azure Blob Storage</option>
          <option value="sftp">SFTP</option>
          <option value="webdav">WebDAV</option>
          <option value="box">Box</option>
          <option value="dropbox">Dropbox</option>
          <option value="gcs">Google Cloud Storage</option>
          <option value="gdrive">Google Drive</option>
          <option value="onedrive">OneDrive</option>
        </select>
        {onClose && (
          <button
            onClick={onClose}
            className="flex items-center opacity-50 hover:opacity-100 transition-opacity"
            title={t("common.close")}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      {/* 同期履歴ビュー（トグルで一覧と切り替え） */}
      {showHistory && <SyncHistoryView />}

      {/* 検索・種類絞り込み */}
      {!showHistory && (
      <div className="flex items-center gap-1.5 px-2 py-1 border-b" style={{ borderColor: "var(--kf-border-soft)" }}>
        <Icon name="search" size={12} style={{ color: "var(--kf-text-muted)" }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("cloudSync.searchPlaceholder")}
          className="bg-transparent outline-none flex-1 min-w-0"
          style={{ fontSize: 11, color: "var(--kf-text-primary)" }}
        />
        {query && (
          <button onClick={() => setQuery("")} className="flex items-center opacity-60 hover:opacity-100" title={t("common.close")}>
            <Icon name="close" size={11} />
          </button>
        )}
        {/* ストレージ種類での絞り込み（登録済みの種類のみ列挙） */}
        <select
          value={activeFilter}
          onChange={(e) => setProviderFilter(e.target.value as SyncProvider | "")}
          title={t("cloudSync.filterByProvider")}
          className="bg-transparent outline-none rounded px-1 py-0.5 flex-shrink-0"
          data-testid="provider-filter"
          style={{
            border: `1px solid ${activeFilter ? "var(--kf-accent)" : "var(--kf-border)"}`,
            color: activeFilter ? "var(--kf-accent)" : "var(--kf-text-muted)",
            fontSize: 10,
            maxWidth: 110,
          }}
        >
          <option value="">{t("cloudSync.filterAllProviders")}</option>
          {usedProviders.map((p) => (
            <option key={p} value={p}>
              {providerLabel(p)} ({jobs.filter((j) => j.provider === p).length})
            </option>
          ))}
        </select>
      </div>
      )}

      {/* Empty */}
      {!showHistory && loaded && jobs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 gap-2 px-4 text-center" style={{ color: "var(--kf-text-muted)" }}>
          <Icon name="sync" size={24} />
          <span>{t("cloudSync.noJobs")}</span>
          <span className="text-[10px]">{t("cloudSync.noJobsHint")}</span>
        </div>
      )}

      {/* Jobs */}
      {!showHistory && (
      <div className="flex-1 overflow-y-auto">
        {loaded && jobs.length > 0 && filtered.length === 0 && (
          <div className="flex items-center justify-center py-8 px-4 text-center" style={{ color: "var(--kf-text-muted)" }}>
            {t("cloudSync.noSearchResults")}
          </div>
        )}

        {groupNames.length === 0 ? (
          filtered.map(renderJobCard)
        ) : (
          <>
            {groupNames.map((g) => {
              const members = filtered.filter((j) => j.group === g);
              const collapsed = !searching && collapsedGroups.includes(g);
              return (
                <div key={g}>
                  {renderGroupHeader(g, g, members.length)}
                  {!collapsed && members.map(renderJobCard)}
                </div>
              );
            })}
            {ungrouped.length > 0 && (
              <div>
                {renderGroupHeader("", t("cloudSync.ungrouped"), ungrouped.length)}
                {!(!searching && collapsedGroups.includes("")) && ungrouped.map(renderJobCard)}
              </div>
            )}
          </>
        )}
      </div>
      )}

      {/* Footer */}
      <div className="px-3 py-1.5 border-t text-[10px] shrink-0" style={{ borderColor: "var(--kf-border-soft)", color: "var(--kf-text-muted)" }}>
        <Icon name="lock" size={10} className="inline align-text-bottom mr-1" />
        {t("cloudSync.footerNote")}
      </div>

      {/* 接続設定ポップアップ */}
      {settingsJob && (
        <ConnectionSettingsDialog
          job={settingsJob}
          existingGroups={existingGroups}
          connecting={!!state[settingsJob.id]?.loading}
          onChange={(p) => updateJob(settingsJob.id, p)}
          onConnect={() => handleConnect(settingsJob)}
          onCancelConnect={() => handleCancelConnect(settingsJob)}
          onClose={() => setSettingsJobId(null)}
        />
      )}
    </div>
  );
}

// ── JobCard ────────────────────────────────────────────────────────────
function JobCard({
  job, s, onChange, onRemove, onOpenSettings, onOpenBrowser,
  dragging, dropIndicator, onDragStart, onDragEnd, onDragOverCard, onDropCard,
}: {
  job: CloudSyncJob; s: JobState;
  onChange: (p: Partial<CloudSyncJob>) => void;
  onRemove: () => void; onOpenSettings: () => void;
  onOpenBrowser: () => void;
  dragging: boolean;
  dropIndicator: "top" | "bottom" | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: (before: boolean) => void;
  onDropCard: () => void;
}) {
  const { t } = useTranslation();

  // 名前入力のテキスト選択とドラッグが衝突しないよう、
  // ハンドル（drag_indicator）を押している間だけカードを draggable にする。
  const [dragEnabled, setDragEnabled] = useState(false);

  const connected = !!((job as unknown as Record<string, Record<string, string> | undefined>)[job.provider]?.refreshToken);

  return (
    <div
      className="border-b"
      data-testid={`job-card-${job.id}`}
      draggable={dragEnabled}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", job.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={() => { setDragEnabled(false); onDragEnd(); }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        onDragOverCard(e.clientY < rect.top + rect.height / 2);
      }}
      onDrop={(e) => { e.preventDefault(); onDropCard(); }}
      style={{
        borderColor: "var(--kf-border-soft)",
        opacity: dragging ? 0.4 : 1,
        // ドロップ位置のインジケータ（上/下端のアクセント線）
        boxShadow:
          dropIndicator === "top"
            ? "inset 0 2px 0 0 var(--kf-accent)"
            : dropIndicator === "bottom"
              ? "inset 0 -2px 0 0 var(--kf-accent)"
              : undefined,
      }}
    >
      {/* Summary row（2 行構成） */}
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        {/* 1 行目: ドラッグハンドル + サービスバッジ + 名前 + 設定 + 削除 */}
        <div className="flex items-center gap-1.5">
          <span
            className="flex items-center flex-shrink-0"
            title={t("cloudSync.dragToReorder")}
            style={{ cursor: "grab", color: "var(--kf-text-muted)", marginLeft: -4, marginRight: -4 }}
            onMouseDown={() => setDragEnabled(true)}
            onMouseUp={() => setDragEnabled(false)}
          >
            <Icon name="drag_indicator" size={16} />
          </span>
          <ProviderBadge provider={job.provider} size={18} />
          <input
            value={job.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="flex-1 min-w-0 bg-transparent outline-none px-1 py-0.5 rounded font-medium"
            style={{ border: "1px solid transparent", color: "var(--kf-text-primary)", fontSize: 13 }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--kf-border)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "transparent")}
          />
          {/* クラウドブラウザを開く（展開不要でワンクリック） */}
          <button onClick={onOpenBrowser} className="p-1 rounded hover:opacity-100 opacity-80 kf-native-hover flex items-center flex-shrink-0" title={t("cloudSync.openBrowser")}>
            <Icon name="cloud" size={20} style={{ color: "var(--kf-accent)" }} />
          </button>
          <button onClick={onOpenSettings} className="p-1 rounded hover:opacity-100 opacity-80 kf-native-hover flex items-center flex-shrink-0" title={t("cloudSync.settings")}>
            <Icon name="settings" size={20} style={{ color: "var(--kf-accent)" }} />
          </button>
          <button onClick={onRemove} className="p-1 rounded hover:opacity-100 opacity-80 kf-native-hover flex items-center flex-shrink-0" title={t("cloudSync.delete")}>
            <Icon name="delete" size={20} style={{ color: "var(--kf-error)" }} />
          </button>
        </div>

        {/* 2 行目: プロバイダ名 + 接続方式 + （OAuth のみ）接続状態 + 自動同期トグル */}
        <div className="flex items-center gap-2 pl-[40px]">
          <span style={{ fontSize: 11, color: "var(--kf-text-muted)" }}>
            {job.provider === "s3" ? t("cloudSync.providerS3Short") : providerLabel(job.provider)}
          </span>
          <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--kf-border)", color: "var(--kf-text-muted)" }}>
            {t(methodLabelKey(job.provider))}
          </span>
          {isOauth(job.provider) && (
            <span style={{ fontSize: 10, color: connected ? "var(--kf-success)" : "var(--kf-text-muted)" }}>
              {connected ? t("cloudSync.connectedStatus") : t("cloudSync.notConnected")}
            </span>
          )}
          <span className="flex-1" />
          <label className="flex items-center gap-1 cursor-pointer flex-shrink-0" style={{ fontSize: 10, color: "var(--kf-text-muted)" }}>
            <input type="checkbox" checked={job.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
            {t("cloudSync.autoSyncLabel")}
          </label>
        </div>
      </div>

      {/* Badge: last synced（展開ビュー廃止に伴い常時表示） */}
      {job.lastSyncedAt && (
        <div className="px-3 pb-1 text-[10px]" style={{ color: "var(--kf-text-muted)" }}>
          {t("cloudSync.lastSync", { time: formatTs(job.lastSyncedAt) })}
        </div>
      )}

      {/* Progress（同期中のみ） */}
      {s.progress && (
        <div className="px-3 pb-1 text-[10px] truncate" style={{ color: "var(--kf-text-muted)" }}>{s.progress}</div>
      )}

      {/* Errors（省略表示。全文はログウィンドウで） */}
      {s.errorLines.length > 0 && (
        <div className="mx-3 mb-2 rounded px-2 py-1 text-[10px]" style={{ backgroundColor: "var(--kf-error-bg)", color: "#fca5a5" }}>
          {s.errorLines.map((e, i) => <div key={i} className="truncate">{e}</div>)}
          <button
            onClick={() => void openSyncLogWindow()}
            className="flex items-center gap-1 mt-0.5 hover:opacity-80"
            style={{ color: "var(--kf-accent)" }}
          >
            <Icon name="open_in_new" size={10} />
            {t("cloudSync.historyOpenLog")}
          </button>
        </div>
      )}
    </div>
  );
}
