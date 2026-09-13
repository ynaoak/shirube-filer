import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Icon from "../common/Icon";
import { useForgetPathMetadata } from "../../hooks/useFollowPathChange";
import { stripTrashMarker } from "../../lib/trashError";

type DuplicateGroup = {
  hash: string;
  size: number;
  paths: string[];
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type Props = {
  currentPath: string;
  onClose: () => void;
};

export default function DuplicatePanel({ currentPath, onClose }: Props) {
  // 削除したファイルのタグ・カラーラベルを捨てる
  const forgetPathMetadata = useForgetPathMetadata();
  const { t } = useTranslation();
  const [scanDirs, setScanDirs] = useState<string[]>([currentPath].filter(Boolean));
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keepMap, setKeepMap] = useState<Map<string, string>>(new Map()); // group hash → keep path
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const addDir = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected && !scanDirs.includes(selected as string)) {
      setScanDirs((prev) => [...prev, selected as string]);
    }
  };

  const removeDir = (dir: string) => {
    setScanDirs((prev) => prev.filter((d) => d !== dir));
  };

  const scan = useCallback(async () => {
    if (scanDirs.length === 0) return;
    setLoading(true);
    setError(null);
    setGroups([]);
    setKeepMap(new Map());
    try {
      const result = await invoke<DuplicateGroup[]>("find_duplicates", { dirs: scanDirs });
      setGroups(result);
      // Default: keep the first path in each group
      const defaultKeep = new Map(result.map((g) => [g.hash, g.paths[0]]));
      setKeepMap(defaultKeep);
      setExpanded(new Set(result.slice(0, 5).map((g) => g.hash)));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [scanDirs]);

  const deleteSelected = async () => {
    const toDelete: string[] = [];
    for (const group of groups) {
      const keep = keepMap.get(group.hash);
      for (const path of group.paths) {
        if (path !== keep) toDelete.push(path);
      }
    }
    if (toDelete.length === 0) return;
    if (!confirm(t("duplicatePanel.confirmDelete", { count: toDelete.length }))) return;
    setBusy(true);
    const errors: string[] = [];
    const deleted: string[] = [];
    for (const path of toDelete) {
      try {
        await invoke("delete_item", { path, trash: true });
        deleted.push(path);
      } catch (e) {
        errors.push(stripTrashMarker(String(e)));
      }
    }
    // 消したファイルのタグ・カラーラベルは残さない
    forgetPathMetadata(deleted);
    if (errors.length) setError(errors.join("\n"));
    await scan();
    setBusy(false);
  };

  const totalWasted = groups.reduce((sum, g) => sum + g.size * (g.paths.length - 1), 0);
  const deleteCount = groups.reduce((sum, g) => sum + g.paths.length - 1, 0);

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-40 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="kf-anim-scale flex flex-col rounded-lg shadow-xl overflow-hidden text-xs"
        style={{
          width: "min(860px, 96vw)",
          height: "min(680px, 90vh)",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-2 shrink-0 border-b"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          <Icon name="content_copy" size={14} style={{ color: "var(--kf-accent)" }} />
          <span className="font-semibold">{t("duplicatePanel.title")}</span>
          <div className="flex-1" />
          <button aria-label={t("common.close")} onClick={onClose} className="opacity-60 hover:opacity-100">
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* Scan dirs */}
        <div
          className="px-4 py-2 shrink-0 border-b"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span style={{ color: "var(--kf-text-muted)" }}>{t("duplicatePanel.scanTarget")}</span>
            <button
              onClick={addDir}
              className="flex items-center gap-1 px-2 py-0.5 rounded opacity-70 hover:opacity-100"
              style={{ border: "1px solid var(--kf-border)" }}
            >
              <Icon name="add" size={12} />
              {t("duplicatePanel.addFolder")}
            </button>
            <button
              onClick={scan}
              disabled={loading || scanDirs.length === 0}
              className="flex items-center gap-1 px-3 py-1 rounded disabled:opacity-30"
              style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
            >
              <Icon name="search" size={12} />
              {t("duplicatePanel.startScan")}
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {scanDirs.map((dir) => (
              <div
                key={dir}
                className="flex items-center gap-1 px-2 py-0.5 rounded"
                style={{ backgroundColor: "var(--kf-bg-tertiary)", border: "1px solid var(--kf-border)" }}
              >
                <Icon name="folder" size={11} style={{ color: "#fbbf24" }} />
                <span className="max-w-[200px] truncate" title={dir}>{dir.split(/[\\/]/).pop() || dir}</span>
                <button
                  onClick={() => removeDir(dir)}
                  className="opacity-50 hover:opacity-100"
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-3 py-1 shrink-0 text-xs" style={{ backgroundColor: "var(--kf-error-bg)", color: "#fca5a5" }}>
            {error}
            <button className="ml-2 underline" onClick={() => setError(null)}>{t("duplicatePanel.closeError")}</button>
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-24 opacity-50 gap-2">
              <Icon name="hourglass_empty" size={20} />
              <span>{t("duplicatePanel.hashing")}</span>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 opacity-40 gap-2">
              <Icon name="check_circle" size={28} />
              <span>{scanDirs.length > 0 ? t("duplicatePanel.noDuplicates") : t("duplicatePanel.addFolderHint")}</span>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: "var(--kf-border-soft)" }}>
              {groups.map((group) => {
                const isOpen = expanded.has(group.hash);
                const keep = keepMap.get(group.hash) ?? group.paths[0];
                return (
                  <div key={group.hash}>
                    {/* Group header */}
                    <div
                      className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:opacity-80"
                      style={{ backgroundColor: "var(--kf-bg-secondary)" }}
                      onClick={() => setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.hash)) next.delete(group.hash);
                        else next.add(group.hash);
                        return next;
                      })}
                    >
                      <Icon name={isOpen ? "expand_less" : "expand_more"} size={13} />
                      <Icon name="content_copy" size={12} style={{ color: "var(--kf-warning)" }} />
                      <span className="font-semibold">{t("duplicatePanel.duplicateCount", { count: group.paths.length })}</span>
                      <span style={{ color: "var(--kf-text-muted)" }}>{t("duplicatePanel.wastedSize", { size: formatSize(group.size), num: group.paths.length - 1, total: formatSize(group.size * (group.paths.length - 1)) })}</span>
                      <span className="ml-auto font-mono text-[10px] opacity-40">{group.hash.slice(0, 8)}</span>
                    </div>
                    {isOpen && (
                      <div className="divide-y" style={{ borderColor: "var(--kf-border-soft)" }}>
                        {group.paths.map((path) => {
                          const isKeep = path === keep;
                          return (
                            <div
                              key={path}
                              className="flex items-center gap-2 px-5 py-1.5 hover:opacity-80"
                              style={{
                                backgroundColor: isKeep
                                  ? "color-mix(in srgb, var(--kf-success) 10%, transparent)"
                                  : "color-mix(in srgb, var(--kf-error) 8%, transparent)",
                              }}
                            >
                              <input
                                type="radio"
                                name={`keep-${group.hash}`}
                                checked={isKeep}
                                onChange={() => setKeepMap((prev) => new Map(prev).set(group.hash, path))}
                                title={t("duplicatePanel.keepThisFile")}
                              />
                              <Icon
                                name={isKeep ? "check_circle" : "delete"}
                                size={12}
                                style={{ color: isKeep ? "var(--kf-success)" : "var(--kf-error)" }}
                              />
                              <span
                                className="flex-1 truncate"
                                style={{ color: isKeep ? "var(--kf-text-primary)" : "var(--kf-text-muted)" }}
                                title={path}
                              >
                                {path}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {groups.length > 0 && (
          <div
            className="px-3 py-2 shrink-0 border-t flex items-center gap-3"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
          >
            <span style={{ color: "var(--kf-text-muted)" }}>
              {t("duplicatePanel.summary", { groups: groups.length, count: deleteCount, size: formatSize(totalWasted) })}
            </span>
            <div className="flex-1" />
            <button
              onClick={deleteSelected}
              disabled={busy || deleteCount === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded disabled:opacity-30"
              style={{ backgroundColor: "var(--kf-error)", color: "#fff" }}
            >
              <Icon name="delete" size={13} />
              {t("duplicatePanel.deleteSelected", { count: deleteCount })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
