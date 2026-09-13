import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

const MIN_WIDTH = 160;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 224; // w-56
const LOG_PAGE_SIZE = 30;
import { invoke } from "@tauri-apps/api/core";
import Icon from "../common/Icon";
import GitIcon from "../common/GitIcon";

type GitFileStatus = {
  path: string;
  status: string;
};

type GitCommit = {
  oid: string;
  message: string;
  author: string;
  time: number;
};

type GitStashEntry = { index: number; message: string };

type GitBranch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
};

type GitRepoStatus = {
  root: string;
  head: string;
  files: GitFileStatus[];
  branches: GitBranch[];
};

const STATUS_COLOR: Record<string, string> = {
  "staged-new":      "#22c55e",
  "staged-modified": "#06b6d4",
  "staged-deleted":  "#ef4444",
  modified:          "#eab308",
  deleted:           "#ef4444",
  untracked:         "#a3a3a3",
};

const STATUS_LABEL: Record<string, string> = {
  "staged-new": "A",
  "staged-modified": "M",
  "staged-deleted": "D",
  modified: "M",
  deleted: "D",
  untracked: "?",
};

function isStaged(status: string) {
  return status.startsWith("staged-");
}

type DiffLine = { type: "add" | "del" | "ctx" | "hunk"; text: string };

function parseDiff(raw: string): DiffLine[] {
  return raw.split("\n").map((line): DiffLine => {
    if (line.startsWith("+") && !line.startsWith("+++")) return { type: "add", text: line };
    if (line.startsWith("-") && !line.startsWith("---")) return { type: "del", text: line };
    if (line.startsWith("@@")) return { type: "hunk", text: line };
    return { type: "ctx", text: line };
  });
}

type Props = {
  activePath: string;
  onClose?: () => void;
};

export default function GitPanel({ activePath, onClose }: Props) {
  const { t } = useTranslation();
  const [width, setWidth] = useState<number>(() => {
    const saved = localStorage.getItem("kf-git-panel-width");
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return isNaN(parsed) ? DEFAULT_WIDTH : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
  });
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const dragStartXRef = useRef<number | null>(null);
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartXRef.current = e.clientX;
    const startWidth = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      if (dragStartXRef.current === null) return;
      const delta = dragStartXRef.current - ev.clientX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(newWidth);
      localStorage.setItem("kf-git-panel-width", String(newWidth));
    };
    const onUp = () => {
      dragStartXRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  type GitPanelTab = "status" | "log" | "stash";
  const [activeTab, setActiveTab] = useState<GitPanelTab>("status");
  const [status, setStatus] = useState<GitRepoStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBranches, setShowBranches] = useState(false);

  // Log view
  const [logCommits, setLogCommits] = useState<GitCommit[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logOffset, setLogOffset] = useState(0);
  const [logHasMore, setLogHasMore] = useState(true);
  const [selectedCommitOid, setSelectedCommitOid] = useState<string | null>(null);
  const [commitDiffLines, setCommitDiffLines] = useState<DiffLine[]>([]);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);

  // Stash
  const [stashEntries, setStashEntries] = useState<GitStashEntry[]>([]);
  const [stashLoading, setStashLoading] = useState(false);
  const [stashMsg, setStashMsg] = useState("");
  const [stashSaving, setStashSaving] = useState(false);

  // Stable primitive for callbacks — avoids recreating loadLog/loadStash on every status refresh
  const repoRoot = status?.root ?? null;

  // staging / commit UI
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // diff viewer
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffLines, setDiffLines] = useState<DiffLine[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!activePath) {
      setError(t("gitPanel.openFilePaneFirst"));
      setStatus(null);
      return;
    }
    setStatusLoading(true);
    try {
      const result = await invoke<GitRepoStatus>("git_repo_status", { path: activePath });
      setStatus(result);
      setError(null);
    } catch {
      setStatus(null);
      setError(t("gitPanel.noGitRepo"));
    } finally {
      setStatusLoading(false);
    }
  }, [activePath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleStage = useCallback(async (path: string) => {
    if (!status) return;
    try {
      await invoke("git_stage", { repoPath: status.root, paths: [path] });
      refresh().catch(console.error);
    } catch (e) {
      console.error("[git_stage]", e);
    }
  }, [status, refresh]);

  const handleUnstage = useCallback(async (path: string) => {
    if (!status) return;
    try {
      await invoke("git_unstage", { repoPath: status.root, paths: [path] });
      refresh().catch(console.error);
    } catch (e) {
      console.error("[git_unstage]", e);
    }
  }, [status, refresh]);

  const handleCommit = useCallback(async () => {
    if (!status || !commitMsg.trim()) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await invoke("git_commit", { repoPath: status.root, message: commitMsg.trim() });
      setCommitMsg("");
      refresh().catch(console.error);
    } catch (e) {
      setCommitError(typeof e === "string" ? e : t("gitPanel.commitFailed"));
    } finally {
      setCommitting(false);
    }
  }, [status, commitMsg, refresh]);

  const handleCheckoutBranch = useCallback(async (branch: string) => {
    if (!status) return;
    try {
      await invoke("git_checkout_branch", { repoPath: status.root, branch });
      refresh().catch(console.error);
    } catch (e) {
      console.error("[git_checkout_branch]", e);
    }
  }, [status, refresh]);

  const handleShowDiff = useCallback(async (path: string) => {
    if (!status) return;
    if (diffPath === path) {
      setDiffPath(null);
      return;
    }
    setDiffPath(path);
    setDiffLoading(true);
    try {
      const raw = await invoke<string>("git_diff", { repoPath: status.root, path });
      setDiffLines(parseDiff(raw));
    } catch (e) {
      console.error("[git_diff]", e);
      setDiffLines([]);
    } finally {
      setDiffLoading(false);
    }
  }, [status, diffPath]);

  const loadLog = useCallback(async (offset: number, append: boolean) => {
    if (!repoRoot) return;
    setLogLoading(true);
    try {
      const page = await invoke<GitCommit[]>("git_log", { repoPath: repoRoot, limit: LOG_PAGE_SIZE, offset });
      setLogCommits((prev) => append ? [...prev, ...page] : page);
      setLogOffset(offset + page.length);
      setLogHasMore(page.length === LOG_PAGE_SIZE);
    } catch (e) {
      console.error("[git_log]", e);
    } finally {
      setLogLoading(false);
    }
  }, [repoRoot]);

  // Reset log state when the repo changes so stale commits from the previous repo don't persist
  useEffect(() => {
    setLogCommits([]);
    setLogOffset(0);
    setLogHasMore(true);
    setSelectedCommitOid(null);
    setCommitDiffLines([]);
  }, [status?.root]);

  useEffect(() => {
    if (activeTab === "log" && status && logCommits.length === 0) {
      loadLog(0, false);
    }
  }, [activeTab, status, loadLog]);

  const handleShowCommitDiff = useCallback(async (oid: string) => {
    if (!status) return;
    if (selectedCommitOid === oid) {
      setSelectedCommitOid(null);
      return;
    }
    setSelectedCommitOid(oid);
    setCommitDiffLoading(true);
    try {
      const raw = await invoke<string>("git_show", { repoPath: status.root, oid });
      setCommitDiffLines(parseDiff(raw));
    } catch (e) {
      console.error("[git_show]", e);
      setCommitDiffLines([]);
    } finally {
      setCommitDiffLoading(false);
    }
  }, [status, selectedCommitOid]);

  const loadStash = useCallback(async () => {
    if (!repoRoot) return;
    setStashLoading(true);
    try {
      const list = await invoke<GitStashEntry[]>("git_stash_list", { repoPath: repoRoot });
      setStashEntries(list);
    } catch (e) {
      console.error("[git_stash_list]", e);
    } finally {
      setStashLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (activeTab === "stash" && status) loadStash();
  }, [activeTab, status, loadStash]);

  const handleStashSave = useCallback(async () => {
    if (!status) return;
    setStashSaving(true);
    try {
      await invoke("git_stash_save", { repoPath: status.root, message: stashMsg.trim() });
      setStashMsg("");
      await loadStash();
      refresh().catch(console.error);
    } catch (e) {
      console.error("[git_stash_save]", e);
    } finally {
      setStashSaving(false);
    }
  }, [status, stashMsg, loadStash, refresh]);

  const handleStashPop = useCallback(async (index: number) => {
    if (!status) return;
    try {
      await invoke("git_stash_pop", { repoPath: status.root, index });
      await loadStash();
      refresh().catch(console.error);
    } catch (e) { console.error("[git_stash_pop]", e); }
  }, [status, loadStash, refresh]);

  const handleStashApply = useCallback(async (index: number) => {
    if (!status) return;
    try {
      await invoke("git_stash_apply", { repoPath: status.root, index });
      await loadStash();
      refresh().catch(console.error);
    } catch (e) { console.error("[git_stash_apply]", e); }
  }, [status, loadStash, refresh]);

  const handleStashDrop = useCallback(async (index: number) => {
    if (!status) return;
    try {
      await invoke("git_stash_drop", { repoPath: status.root, index });
      await loadStash();
    } catch (e) { console.error("[git_stash_drop]", e); }
  }, [status, loadStash]);

  const formatTime = (secs: number) => {
    const d = new Date(secs * 1000);
    return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
  };

  const stagedFiles = status?.files.filter((f) => isStaged(f.status)) ?? [];
  const unstagedFiles = status?.files.filter((f) => !isStaged(f.status)) ?? [];

  return (
    <div
      className="flex-shrink-0 flex flex-col overflow-hidden border-l text-xs relative"
      style={{
        width,
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* リサイズハンドル */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500 hover:opacity-60"
        style={{ touchAction: "none" }}
        onMouseDown={handleDragStart}
      />
      {/* Header */}
      <div
        className="flex items-center gap-1 px-3 py-2 border-b shrink-0"
        style={{
          backgroundColor: "var(--kf-bg-secondary)",
          borderColor: "var(--kf-border)",
        }}
      >
        <GitIcon size={14} style={{ color: "var(--kf-text-muted)" }} />
        <span className="font-semibold">Git</span>
        {status && (
          <span className="truncate ml-1 flex-1" style={{ color: "var(--kf-accent)" }}>
            {status.head}
          </span>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto flex items-center opacity-50 hover:opacity-100 transition-opacity"
            title={t("gitPanel.closePanel")}
          >
            <Icon name="close" size={14} />
          </button>
        )}
        <button
          onClick={refresh}
          className="ml-1 opacity-50 hover:opacity-100 flex items-center"
          title={t("gitPanel.refresh")}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {/* タブバー */}
      <div
        className="flex flex-col shrink-0 border-b"
        style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
      >
        {(["status", "log", "stash"] as GitPanelTab[]).map((tab) => {
          const labels: Record<GitPanelTab, string> = { status: t("gitPanel.tabChanges"), log: t("gitPanel.tabLog"), stash: t("gitPanel.tabStash") };
          const icons: Record<GitPanelTab, string> = { status: "difference", log: "history", stash: "inventory_2" };
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs transition-colors text-left"
              style={{
                color: activeTab === tab ? "var(--kf-text-primary)" : "var(--kf-text-muted)",
                borderLeft: activeTab === tab ? "2px solid var(--kf-accent)" : "2px solid transparent",
                backgroundColor: activeTab === tab ? "color-mix(in srgb, var(--kf-accent) 8%, transparent)" : undefined,
              }}
            >
              <Icon name={icons[tab]} size={15} />
              {labels[tab]}
            </button>
          );
        })}
      </div>

      {error && (
        <div
          className="p-3 text-center leading-relaxed"
          style={{ color: "var(--kf-text-muted)" }}
        >
          {error}
        </div>
      )}

      {/* 初回ステータス読み込み中スケルトン */}
      {statusLoading && !status && !error && (
        <div className="flex-1 overflow-hidden px-1 pt-1">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 px-2" style={{ height: 22 }}>
              <div className="skeleton-shimmer shrink-0 rounded" style={{ width: 8, height: 12 }} />
              <div className="skeleton-shimmer h-2.5 rounded" style={{ width: `${35 + (i * 13 % 45)}%` }} />
            </div>
          ))}
        </div>
      )}

      {status && activeTab === "log" && (
        <div className="flex-1 overflow-y-auto">
          {logLoading && logCommits.length === 0 ? (
            /* 初回ロードスケルトン */
            Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="px-3 py-2 border-b" style={{ borderColor: "var(--kf-border-soft)" }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <div className="skeleton-shimmer rounded shrink-0" style={{ width: 28, height: 10 }} />
                  <div className="skeleton-shimmer h-2.5 rounded" style={{ width: `${45 + (i * 11 % 40)}%` }} />
                </div>
                <div className="skeleton-shimmer h-2 rounded" style={{ width: `${25 + (i * 7 % 25)}%` }} />
              </div>
            ))
          ) : (
          <>
          {logCommits.map((c) => (
            <div key={c.oid}>
              <button
                className="w-full flex flex-col px-3 py-1.5 text-left transition-colors border-b"
                style={{
                  borderColor: "var(--kf-border-soft)",
                  backgroundColor: selectedCommitOid === c.oid ? "var(--kf-bg-tertiary)" : undefined,
                }}
                onMouseEnter={(e) => { if (selectedCommitOid !== c.oid) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                onMouseLeave={(e) => { if (selectedCommitOid !== c.oid) (e.currentTarget as HTMLButtonElement).style.backgroundColor = ""; }}
                onClick={() => handleShowCommitDiff(c.oid)}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[9px] shrink-0" style={{ color: "var(--kf-accent)" }}>{c.oid.slice(0, 7)}</span>
                  <span className="truncate text-[10px]" style={{ color: "var(--kf-text-primary)" }}>{c.message}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5" style={{ color: "var(--kf-text-muted)" }}>
                  <span className="text-[9px] truncate flex-1">{c.author}</span>
                  <span className="text-[9px] shrink-0">{formatTime(c.time)}</span>
                </div>
              </button>
              {selectedCommitOid === c.oid && (
                <div className="border-b" style={{ borderColor: "var(--kf-border)", maxHeight: 300, overflowY: "auto" }}>
                  <DiffViewer lines={commitDiffLines} loading={commitDiffLoading} />
                </div>
              )}
            </div>
          ))}
          {logLoading && (
            <div className="flex items-center justify-center py-3 gap-1" style={{ color: "var(--kf-text-muted)" }}>
              <Icon name="progress_activity" size={14} className="animate-spin" />
              <span className="text-xs">{t("gitPanel.loadingDiff")}</span>
            </div>
          )}
          {!logLoading && logHasMore && (
            <button
              className="w-full py-2 text-[10px] transition-colors"
              style={{ color: "var(--kf-text-muted)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--kf-text-primary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--kf-text-muted)"; }}
              onClick={() => loadLog(logOffset, true)}
            >
              {t("gitPanel.loadMore")}
            </button>
          )}
          {!logLoading && logCommits.length === 0 && (
            <div className="flex items-center justify-center py-4 text-xs" style={{ color: "var(--kf-text-muted)" }}>
              {t("gitPanel.noCommits")}
            </div>
          )}
          </>
          )}
        </div>
      )}

      {status && activeTab === "stash" && (
        <div className="flex-1 overflow-y-auto flex flex-col">
          {/* 新規スタッシュ保存 */}
          <div
            className="flex items-center gap-1 px-3 py-1.5 border-b shrink-0"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
          >
            <input
              className="flex-1 px-1 py-0.5 rounded border text-[10px]"
              style={{ backgroundColor: "var(--kf-bg-tertiary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
              placeholder={t("gitPanel.stashMessagePlaceholder")}
              value={stashMsg}
              onChange={(e) => setStashMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleStashSave(); } }}
            />
            <button
              onClick={handleStashSave}
              disabled={stashSaving}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors disabled:opacity-40"
              style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
              title={t("gitPanel.stashCurrentChanges")}
            >
              <Icon name="save" size={11} />
              {t("common.save")}
            </button>
          </div>

          {stashLoading && stashEntries.length === 0 && (
            /* 初回ロードスケルトン */
            Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "var(--kf-border-soft)" }}>
                <div className="skeleton-shimmer h-2.5 rounded flex-1" style={{ maxWidth: `${45 + i * 15}%` }} />
                <div className="skeleton-shimmer rounded shrink-0" style={{ width: 14, height: 14 }} />
              </div>
            ))
          )}

          {!stashLoading && stashEntries.length === 0 && (
            <div className="flex flex-col items-center justify-center flex-1 gap-1" style={{ color: "var(--kf-text-muted)" }}>
              <Icon name="inventory_2" size={24} />
              <span className="text-xs">{t("gitPanel.noStash")}</span>
            </div>
          )}

          {stashEntries.map((s) => (
            <div
              key={s.index}
              className="flex items-center gap-1.5 px-3 py-1.5 border-b group"
              style={{ borderColor: "var(--kf-border-soft)" }}
            >
              <span className="font-mono text-[9px] shrink-0" style={{ color: "var(--kf-accent)" }}>
                {`stash@{${s.index}}`}
              </span>
              <span className="flex-1 truncate text-[10px]" style={{ color: "var(--kf-text-primary)" }}>
                {s.message}
              </span>
              <button
                className="opacity-0 group-hover:opacity-80 hover:!opacity-100 flex items-center shrink-0"
                title={t("gitPanel.stashPop")}
                onClick={() => handleStashPop(s.index)}
              >
                <Icon name="play_arrow" size={13} />
              </button>
              <button
                className="opacity-0 group-hover:opacity-80 hover:!opacity-100 flex items-center shrink-0"
                title={t("gitPanel.stashApply")}
                onClick={() => handleStashApply(s.index)}
              >
                <Icon name="download" size={13} />
              </button>
              <button
                className="opacity-0 group-hover:opacity-80 hover:!opacity-100 flex items-center shrink-0"
                title={t("gitPanel.deleteStash")}
                onClick={() => handleStashDrop(s.index)}
                style={{ color: "var(--kf-error)" }}
              >
                <Icon name="delete" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {status && activeTab === "status" && (
        <div className="flex-1 overflow-y-auto">
          {/* Branches */}
          <button
            onClick={() => setShowBranches((v) => !v)}
            className="w-full flex items-center gap-1 px-3 py-1.5 transition-colors"
            style={{ color: "var(--kf-text-secondary)" }}
          >
            <Icon
              name={showBranches ? "expand_more" : "chevron_right"}
              size={14}
              style={{ color: "var(--kf-text-muted)" }}
            />
            <span className="font-semibold">{t("gitPanel.branches")}</span>
            <span className="ml-auto" style={{ color: "var(--kf-text-muted)" }}>
              {status.branches.filter((b) => !b.isRemote).length}
            </span>
          </button>

          {showBranches && (
            <div className="pb-1">
              {status.branches
                .filter((b) => !b.isRemote)
                .map((b) => (
                  <button
                    key={b.name}
                    onClick={() => !b.isCurrent && handleCheckoutBranch(b.name)}
                    className="w-full flex items-center gap-1 px-4 py-0.5 truncate text-left hover:opacity-80"
                    style={{
                      color: b.isCurrent ? "var(--kf-accent)" : "var(--kf-text-secondary)",
                      fontWeight: b.isCurrent ? 600 : undefined,
                      cursor: b.isCurrent ? "default" : "pointer",
                    }}
                  >
                    {b.isCurrent && <Icon name="check" size={12} style={{ color: "var(--kf-accent)" }} />}
                    <span className="truncate">{b.name}</span>
                  </button>
                ))}

              {status.branches.some((b) => b.isRemote) && (
                <>
                  <div
                    className="px-3 py-0.5 mt-1"
                    style={{ color: "var(--kf-text-muted)" }}
                  >
                    {t("gitPanel.remote")}
                  </div>
                  {status.branches
                    .filter((b) => b.isRemote)
                    .map((b) => (
                      <div
                        key={b.name}
                        className="px-4 py-0.5 truncate"
                        style={{ color: "var(--kf-text-muted)" }}
                      >
                        {b.name}
                      </div>
                    ))}
                </>
              )}
            </div>
          )}

          {/* Staged files */}
          <div
            className="flex items-center gap-1 px-3 py-1.5 border-t"
            style={{
              color: "var(--kf-text-secondary)",
              borderColor: "var(--kf-border-soft)",
            }}
          >
            <span className="font-semibold">{t("gitPanel.staged")}</span>
            <span className="ml-auto" style={{ color: "var(--kf-text-muted)" }}>
              {stagedFiles.length}
            </span>
          </div>

          {stagedFiles.length === 0 ? (
            <div className="px-4 py-0.5" style={{ color: "var(--kf-text-muted)" }}>{t("gitPanel.none")}</div>
          ) : (
            stagedFiles.map((f) => (
              <div key={f.path}>
                <div
                  className="flex items-center gap-1.5 px-3 py-0.5 group"
                  title={f.path}
                >
                  <span
                    className="font-mono w-3 shrink-0"
                    style={{ color: STATUS_COLOR[f.status] ?? "var(--kf-text-muted)" }}
                  >
                    {STATUS_LABEL[f.status] ?? "?"}
                  </span>
                  <button
                    className="truncate flex-1 text-left hover:underline"
                    style={{ color: "var(--kf-text-primary)" }}
                    onClick={() => handleShowDiff(f.path)}
                    title={t("gitPanel.showDiff")}
                  >
                    {f.path.split("/").pop() ?? f.path}
                  </button>
                  <button
                    className="opacity-0 group-hover:opacity-70 hover:!opacity-100 flex items-center shrink-0"
                    onClick={() => handleUnstage(f.path)}
                    title={t("gitPanel.unstage")}
                  >
                    <Icon name="remove" size={12} />
                  </button>
                </div>
                {diffPath === f.path && (
                  <DiffViewer lines={diffLines} loading={diffLoading} />
                )}
              </div>
            ))
          )}

          {/* Commit area */}
          <div
            className="px-3 py-2 border-t"
            style={{ borderColor: "var(--kf-border-soft)" }}
          >
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder={t("gitPanel.commitMessagePlaceholder")}
              rows={2}
              className="w-full resize-none rounded px-2 py-1 text-xs outline-none"
              style={{
                backgroundColor: "var(--kf-bg-secondary)",
                color: "var(--kf-text-primary)",
                border: "1px solid var(--kf-border)",
              }}
            />
            {commitError && (
              <div className="mt-1" style={{ color: "var(--kf-error)" }}>{commitError}</div>
            )}
            <button
              onClick={handleCommit}
              disabled={committing || !commitMsg.trim() || stagedFiles.length === 0}
              className="mt-1.5 w-full py-1 rounded text-xs font-semibold disabled:opacity-40"
              style={{
                backgroundColor: "var(--kf-accent)",
                color: "var(--kf-accent-fg, #fff)",
              }}
            >
              {committing ? t("gitPanel.committing") : t("gitPanel.commit")}
            </button>
          </div>

          {/* Unstaged files */}
          <div
            className="flex items-center gap-1 px-3 py-1.5 border-t"
            style={{
              color: "var(--kf-text-secondary)",
              borderColor: "var(--kf-border-soft)",
            }}
          >
            <span className="font-semibold">{t("gitPanel.changedFiles")}</span>
            <span className="ml-auto" style={{ color: "var(--kf-text-muted)" }}>
              {unstagedFiles.length}
            </span>
          </div>

          {unstagedFiles.length === 0 ? (
            <div className="px-4 py-0.5" style={{ color: "var(--kf-text-muted)" }}>{t("gitPanel.noChanges")}</div>
          ) : (
            unstagedFiles.map((f) => (
              <div key={f.path}>
                <div
                  className="flex items-center gap-1.5 px-3 py-0.5 group"
                  title={f.path}
                >
                  <span
                    className="font-mono w-3 shrink-0"
                    style={{ color: STATUS_COLOR[f.status] ?? "var(--kf-text-muted)" }}
                  >
                    {STATUS_LABEL[f.status] ?? "?"}
                  </span>
                  <button
                    className="truncate flex-1 text-left hover:underline"
                    style={{ color: "var(--kf-text-primary)" }}
                    onClick={() => handleShowDiff(f.path)}
                    title={t("gitPanel.showDiff")}
                  >
                    {f.path.split("/").pop() ?? f.path}
                  </button>
                  <button
                    className="opacity-0 group-hover:opacity-70 hover:!opacity-100 flex items-center shrink-0"
                    onClick={() => handleStage(f.path)}
                    title={t("gitPanel.stage")}
                  >
                    <Icon name="add" size={12} />
                  </button>
                </div>
                {diffPath === f.path && (
                  <DiffViewer lines={diffLines} loading={diffLoading} />
                )}
              </div>
            ))
          )}

        </div>
      )}
    </div>
  );
}

function DiffViewer({ lines, loading }: { lines: DiffLine[]; loading: boolean }) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="px-4 py-1" style={{ color: "var(--kf-text-muted)" }}>
        {t("gitPanel.loadingDiff")}
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div className="px-4 py-1" style={{ color: "var(--kf-text-muted)" }}>
        {t("gitPanel.noDiff")}
      </div>
    );
  }
  return (
    <div
      className="mx-2 mb-1 rounded overflow-x-auto font-mono"
      style={{
        backgroundColor: "var(--kf-bg-secondary)",
        border: "1px solid var(--kf-border-soft)",
        fontSize: "10px",
        lineHeight: "1.4",
      }}
    >
      {lines.map((line, i) => {
        let bg = "transparent";
        let color = "var(--kf-text-secondary)";
        if (line.type === "add") { bg = "rgba(34,197,94,0.15)"; color = "#22c55e"; }
        if (line.type === "del") { bg = "rgba(239,68,68,0.15)"; color = "#ef4444"; }
        if (line.type === "hunk") { color = "var(--kf-accent)"; }
        return (
          <div
            key={i}
            className="px-2 whitespace-pre"
            style={{ backgroundColor: bg, color }}
          >
            {line.text || " "}
          </div>
        );
      })}
    </div>
  );
}
