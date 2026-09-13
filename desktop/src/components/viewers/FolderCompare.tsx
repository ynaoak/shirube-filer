import { useState, useCallback, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import Icon from "../common/Icon";

type CompareDirEntry = {
  relativePath: string;
  status: "identical" | "modified" | "left_only" | "right_only";
  leftSize: number | null;
  rightSize: number | null;
  leftModified: number | null;
  rightModified: number | null;
  isDir: boolean;
};

type Filter = "all" | "diff" | "left_only" | "right_only" | "modified" | "identical";

const STATUS_COLOR: Record<string, string> = {
  left_only: "#60a5fa",
  right_only: "var(--kf-success)",
  modified: "#fbbf24",
  identical: "var(--kf-text-muted)",
};

function formatSize(v: number | null): string {
  if (v === null) return "—";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString();
}

type Props = {
  leftPath?: string;
  rightPath?: string;
  onClose?: () => void;
  standalone?: boolean;
};

export default function FolderCompare({ leftPath = "", rightPath = "", onClose, standalone = false }: Props) {
  const { t } = useTranslation();
  const STATUS_LABEL: Record<string, string> = {
    left_only: t("folderCompare.leftOnly"),
    right_only: t("folderCompare.rightOnly"),
    modified: t("folderCompare.different"),
    identical: t("folderCompare.identical"),
  };
  const [leftDir, setLeftDir] = useState(leftPath);
  const [rightDir, setRightDir] = useState(rightPath);
  const [entries, setEntries] = useState<CompareDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("diff");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // standalone ウィンドウとして開かれた場合、open/close を main window に通知する。
  // 注意: OS の閉じるボタンでウィンドウが破棄されるときは React の unmount cleanup が
  // 走らないことがあるため、pagehide / beforeunload でも close を通知する（取りこぼし防止）。
  useEffect(() => {
    if (!standalone) return;
    const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kf-compare-window") : null;
    bc?.postMessage({ type: "compare-opened" });
    let notified = false;
    const notifyClosed = () => {
      if (notified) return;
      notified = true;
      try { bc?.postMessage({ type: "compare-closed" }); } catch { /* ignore */ }
    };
    window.addEventListener("pagehide", notifyClosed);
    window.addEventListener("beforeunload", notifyClosed);
    return () => {
      window.removeEventListener("pagehide", notifyClosed);
      window.removeEventListener("beforeunload", notifyClosed);
      notifyClosed();
      bc?.close();
    };
  }, [standalone]);

  // standalone ウィンドウの場合 Escape キーで閉じる
  useEffect(() => {
    if (!standalone) return;
    const handler = async (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      getCurrentWindow().close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [standalone]);

  const load = useCallback(async (left: string, right: string) => {
    if (!left || !right) return;
    setLoading(true);
    setProgress(null);
    setError(null);
    setSelected(new Set());
    const unlisten = await listen<{ done: number; total: number }>("compare-progress", (e) => {
      setProgress(e.payload);
    });
    try {
      const data = await invoke<CompareDirEntry[]>("compare_dirs", { left, right });
      setEntries(data);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setLoading(false);
      setProgress(null);
    }
  }, []);

  // No auto-load: user must press the compare button explicitly

  const pickDir = async (side: "left" | "right") => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") {
      if (side === "left") setLeftDir(selected);
      else setRightDir(selected);
    }
  };

  const displayed = useMemo(() => {
    if (filter === "all") return entries;
    if (filter === "diff") return entries.filter((e) => e.status !== "identical");
    return entries.filter((e) => e.status === filter);
  }, [entries, filter]);

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === displayed.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(displayed.map((e) => e.relativePath)));
    }
  };

  const sync = async (direction: "left-to-right" | "right-to-left") => {
    const targets = displayed.filter((e) => selected.has(e.relativePath));
    if (targets.length === 0) return;

    setBusy(true);
    const sep = leftDir.includes("\\") ? "\\" : "/";
    const errors: string[] = [];
    for (const entry of targets) {
      const relNorm = entry.relativePath.replace(/\//g, sep);
      const src = direction === "left-to-right"
        ? `${leftDir}${sep}${relNorm}`
        : `${rightDir}${sep}${relNorm}`;
      const destDir = direction === "left-to-right"
        ? rightDir
        : leftDir;
      const destPath = `${destDir}${sep}${relNorm}`;
      try {
        await invoke("copy_item", { src, dest: destPath });
      } catch (e) {
        errors.push(`${entry.relativePath}: ${e}`);
      }
    }
    if (errors.length) setError(errors.join("\n"));
    await load(leftDir, rightDir);
    setBusy(false);
  };

  const counts = useMemo(() => ({
    left_only: entries.filter((e) => e.status === "left_only").length,
    right_only: entries.filter((e) => e.status === "right_only").length,
    modified: entries.filter((e) => e.status === "modified").length,
    identical: entries.filter((e) => e.status === "identical").length,
  }), [entries]);

  const selectedList = displayed.filter((e) => selected.has(e.relativePath));

  const inner = (
    <div
      className={standalone ? "flex flex-col w-full h-full text-xs" : "kf-anim-scale flex flex-col rounded-lg shadow-xl overflow-hidden text-xs"}
      style={standalone ? {
        backgroundColor: "var(--kf-bg-primary)",
        color: "var(--kf-text-primary)",
      } : {
        width: "min(1000px, 96vw)",
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
          <Icon name="difference" size={14} style={{ color: "var(--kf-accent)" }} />
          <span className="font-semibold">{t("folderCompare.title")}</span>

          <div className="flex-1 grid grid-cols-2 gap-2 mx-2">
            {/* Left path */}
            <div className="flex items-center gap-1">
              <input
                value={leftDir}
                onChange={(e) => setLeftDir(e.target.value)}
                placeholder={t("folderCompare.leftPathPlaceholder")}
                className="flex-1 px-2 py-0.5 rounded text-xs outline-none truncate"
                style={{
                  backgroundColor: "var(--kf-bg-primary)",
                  border: "1px solid #60a5fa55",
                  color: "#60a5fa",
                }}
              />
              <button
                onClick={() => pickDir("left")}
                className="flex items-center opacity-60 hover:opacity-100 shrink-0"
                title={t("folderCompare.pickFolder")}
              >
                <Icon name="folder_open" size={13} style={{ color: "#60a5fa" }} />
              </button>
            </div>
            {/* Right path */}
            <div className="flex items-center gap-1">
              <input
                value={rightDir}
                onChange={(e) => setRightDir(e.target.value)}
                placeholder={t("folderCompare.rightPathPlaceholder")}
                className="flex-1 px-2 py-0.5 rounded text-xs outline-none truncate"
                style={{
                  backgroundColor: "var(--kf-bg-primary)",
                  border: "1px solid #34d39955",
                  color: "var(--kf-success)",
                }}
              />
              <button
                onClick={() => pickDir("right")}
                className="flex items-center opacity-60 hover:opacity-100 shrink-0"
                title={t("folderCompare.pickFolder")}
              >
                <Icon name="folder_open" size={13} style={{ color: "var(--kf-success)" }} />
              </button>
            </div>
          </div>

          <button
            onClick={() => load(leftDir, rightDir)}
            disabled={loading || busy || !leftDir || !rightDir}
            className="flex items-center gap-1.5 px-3 py-1 rounded font-semibold disabled:opacity-30"
            style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
          >
            <Icon name={loading ? "sync" : "difference"} size={13} style={loading ? { animation: "spin 1s linear infinite" } : undefined} />
            <span>{loading ? t("folderCompare.comparing") : t("folderCompare.compare")}</span>
          </button>
          <button
            onClick={async () => {
              if (onClose) {
                onClose();
              } else if (standalone) {
                const { getCurrentWindow } = await import("@tauri-apps/api/window");
                getCurrentWindow().close();
              }
            }}
            className="opacity-60 hover:opacity-100"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* Filter bar */}
        <div
          className="flex items-center gap-1 px-3 py-1.5 shrink-0 border-b flex-wrap"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          {(["all", "diff", "left_only", "right_only", "modified", "identical"] as Filter[]).map((f) => {
            const count = f === "all" ? entries.length
              : f === "diff" ? counts.left_only + counts.right_only + counts.modified
              : counts[f as keyof typeof counts] ?? 0;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="px-2 py-0.5 rounded"
                style={{
                  backgroundColor: filter === f ? "var(--kf-accent)" : "var(--kf-bg-tertiary)",
                  color: filter === f ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-secondary)",
                  border: "1px solid var(--kf-border)",
                }}
              >
                {f === "all" ? t("folderCompare.showAll") : f === "diff" ? t("folderCompare.showDiffOnly") : STATUS_LABEL[f]}
                {" "}({count})
              </button>
            );
          })}

          <div className="flex-1" />

          {selectedList.length > 0 && (
            <>
              <button
                onClick={() => sync("left-to-right")}
                disabled={busy || selectedList.every((e) => e.status === "right_only")}
                className="flex items-center gap-1 px-2 py-1 rounded disabled:opacity-30"
                style={{ border: "1px solid var(--kf-border)", color: "#60a5fa" }}
                title={t("folderCompare.copyLeftToRight")}
              >
                <Icon name="arrow_forward" size={12} />
                {t("folderCompare.leftToRight", { count: selectedList.length })}
              </button>
              <button
                onClick={() => sync("right-to-left")}
                disabled={busy || selectedList.every((e) => e.status === "left_only")}
                className="flex items-center gap-1 px-2 py-1 rounded disabled:opacity-30"
                style={{ border: "1px solid var(--kf-border)", color: "var(--kf-success)" }}
                title={t("folderCompare.copyRightToLeft")}
              >
                <Icon name="arrow_back" size={12} />
                {t("folderCompare.rightToLeft", { count: selectedList.length })}
              </button>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="px-3 py-1 shrink-0 text-xs" style={{ backgroundColor: "var(--kf-error-bg)", color: "#fca5a5" }}>
            {error}
            <button className="ml-2 underline" onClick={() => setError(null)}>{t("folderCompare.closeError")}</button>
          </div>
        )}

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-24 gap-3">
              <div className="flex items-center gap-2 opacity-60">
                <Icon name="progress_activity" size={18} className="animate-spin" />
                <span className="text-xs">
                  {progress ? t("folderCompare.comparingProgress", { done: progress.done.toLocaleString(), total: progress.total.toLocaleString() }) : t("folderCompare.scanning")}
                </span>
              </div>
              {progress && (
                <div className="w-48 h-1 rounded-full overflow-hidden" style={{ backgroundColor: "var(--kf-bg-tertiary)" }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%`, backgroundColor: "var(--kf-accent)" }}
                  />
                </div>
              )}
            </div>
          ) : displayed.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 opacity-40 gap-2">
              <Icon name="check_circle" size={28} />
              <span>{t("folderCompare.noDiff")}</span>
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr
                  className="sticky top-0 text-left"
                  style={{ backgroundColor: "var(--kf-bg-secondary)", borderBottom: "1px solid var(--kf-border)" }}
                >
                  <th className="px-3 py-1.5 w-6">
                    <input type="checkbox" checked={selected.size === displayed.length && displayed.length > 0} onChange={toggleAll} />
                  </th>
                  <th className="px-2 py-1.5 whitespace-nowrap" style={{ color: "var(--kf-text-muted)", width: 90 }}>{t("folderCompare.colStatus")}</th>
                  <th className="px-2 py-1.5" style={{ color: "var(--kf-text-muted)" }}>{t("folderCompare.colPath")}</th>
                  <th className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: "var(--kf-text-muted)", width: 80 }}>{t("folderCompare.colLeftSize")}</th>
                  <th className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: "var(--kf-text-muted)", width: 80 }}>{t("folderCompare.colRightSize")}</th>
                  <th className="px-2 py-1.5 whitespace-nowrap" style={{ color: "var(--kf-text-muted)", width: 140 }}>{t("folderCompare.colLeftDate")}</th>
                  <th className="px-2 py-1.5 whitespace-nowrap" style={{ color: "var(--kf-text-muted)", width: 140 }}>{t("folderCompare.colRightDate")}</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((entry) => {
                  const isSel = selected.has(entry.relativePath);
                  const color = STATUS_COLOR[entry.status];
                  return (
                    <tr
                      key={entry.relativePath}
                      className="border-b hover:opacity-80 cursor-pointer"
                      style={{
                        borderColor: "var(--kf-border-soft)",
                        backgroundColor: isSel ? "color-mix(in srgb, var(--kf-accent) 12%, transparent)" : undefined,
                      }}
                      onClick={() => toggleSelect(entry.relativePath)}
                    >
                      <td className="px-3 py-1">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleSelect(entry.relativePath)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                          style={{ backgroundColor: color + "33", color }}
                        >
                          {STATUS_LABEL[entry.status]}
                        </span>
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1.5">
                          <Icon
                            name={entry.isDir ? "folder" : "insert_drive_file"}
                            size={12}
                            style={{ color: entry.isDir ? "#fbbf24" : "var(--kf-text-muted)" }}
                          />
                          <span>{entry.relativePath}</span>
                        </div>
                      </td>
                      <td className="px-2 py-1 text-right whitespace-nowrap" style={{ color: "#60a5fa" }}>
                        {formatSize(entry.leftSize)}
                      </td>
                      <td className="px-2 py-1 text-right whitespace-nowrap" style={{ color: "var(--kf-success)" }}>
                        {formatSize(entry.rightSize)}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap" style={{ color: "var(--kf-text-muted)" }}>
                        {formatDate(entry.leftModified)}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap" style={{ color: "var(--kf-text-muted)" }}>
                        {formatDate(entry.rightModified)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-3 py-1 shrink-0 border-t flex items-center gap-3"
          style={{ borderColor: "var(--kf-border)", color: "var(--kf-text-muted)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <span>{t("folderCompare.total", { count: entries.length })}</span>
          <span style={{ color: "#60a5fa" }}>{t("folderCompare.leftOnly_count", { count: counts.left_only })}</span>
          <span style={{ color: "var(--kf-success)" }}>{t("folderCompare.rightOnly_count", { count: counts.right_only })}</span>
          <span style={{ color: "#fbbf24" }}>{t("folderCompare.different_count", { count: counts.modified })}</span>
          <span>{t("folderCompare.identical_count", { count: counts.identical })}</span>
        </div>
      </div>
  );

  if (standalone) {
    return inner;
  }

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-40 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      {inner}
    </div>
  );
}
