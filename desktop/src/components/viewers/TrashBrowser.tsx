import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useMenuClamp } from "../../hooks/useMenuClamp";
import Icon from "../common/Icon";

type TrashEntry = {
  id: string;
  name: string;
  original_path: string;
  deleted_at: number;
  size: number;
  is_dir: boolean;
};

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

export default function TrashBrowser() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await invoke<TrashEntry[]>("list_trash_items");
      setEntries(items);
      setSelected(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === entries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(entries.map((e) => e.original_path)));
    }
  };

  const restore = async (paths: string[]) => {
    setBusy(true);
    const errors: string[] = [];
    for (const p of paths) {
      try {
        await invoke("restore_trash_item", { originalPath: p });
      } catch (e) {
        errors.push(String(e));
      }
    }
    if (errors.length) setError(errors.join("\n"));
    await load();
    setBusy(false);
  };

  const purge = async (paths: string[]) => {
    if (!confirm(t("trashBrowser.confirmDeletePermanent", { count: paths.length }))) return;
    setBusy(true);
    const errors: string[] = [];
    for (const p of paths) {
      try {
        await invoke("purge_trash_item", { originalPath: p });
      } catch (e) {
        errors.push(String(e));
      }
    }
    if (errors.length) setError(errors.join("\n"));
    await load();
    setBusy(false);
  };

  const emptyTrash = async () => {
    if (!confirm(t("trashBrowser.confirmEmpty"))) return;
    setBusy(true);
    try {
      await invoke("empty_trash");
    } catch (e) {
      setError(String(e));
    }
    await load();
    setBusy(false);
  };

  const selectedPaths = Array.from(selected);

  const [pathMenu, setPathMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const { ref: pathMenuRef, pos: pathMenuPos } = useMenuClamp(pathMenu?.x ?? 0, pathMenu?.y ?? 0);

  useEffect(() => {
    if (!pathMenu) return;
    const handler = (e: MouseEvent) => {
      if (pathMenuRef.current && !pathMenuRef.current.contains(e.target as Node)) {
        setPathMenu(null);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [pathMenu]);

  return (
    <div className="flex flex-col h-full text-xs" style={{ color: "var(--kf-text-primary)" }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-1 px-3 py-1.5 shrink-0 border-b"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="delete" size={14} style={{ color: "var(--kf-accent)" }} />
        <span className="font-semibold mr-2">{t("trashBrowser.title")}</span>

        <button
          onClick={load}
          disabled={loading || busy}
          className="flex items-center gap-1 px-2 py-1 rounded opacity-70 hover:opacity-100 disabled:opacity-30"
          style={{ border: "1px solid var(--kf-border)" }}
          title={t("trashBrowser.refresh")}
        >
          <Icon name="refresh" size={13} />
        </button>

        <div className="flex-1" />

        {selectedPaths.length > 0 && (
          <>
            <button
              onClick={() => restore(selectedPaths)}
              disabled={busy}
              className="kf-btn kf-btn-secondary"
              style={{ color: "var(--kf-accent)" }}
            >
              <Icon name="restore_from_trash" size={16} />
              {t("trashBrowser.restore")} ({selectedPaths.length})
            </button>
            <button
              onClick={() => purge(selectedPaths)}
              disabled={busy}
              className="kf-btn kf-btn-danger"
            >
              <Icon name="delete_forever" size={16} />
              {t("trashBrowser.deletePermanently")} ({selectedPaths.length})
            </button>
          </>
        )}

        <button
          onClick={emptyTrash}
          disabled={busy || entries.length === 0}
          className="kf-btn kf-btn-danger"
        >
          <Icon name="delete_sweep" size={13} />
          {t("trashBrowser.empty")}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          className="px-3 py-1 shrink-0 text-xs"
          style={{ backgroundColor: "var(--kf-error-bg)", color: "#fca5a5" }}
        >
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>{t("common.close")}</button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-24 opacity-50">
            <Icon name="hourglass_empty" size={20} />
            <span className="ml-2">{t("trashBrowser.loading")}</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-24 opacity-40 gap-2">
            <Icon name="delete_outline" size={32} />
            <span>{t("trashBrowser.emptyTrash")}</span>
          </div>
        ) : (
          <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 32 }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: 72 }} />
              <col style={{ width: 152 }} />
              <col />
              <col style={{ width: 176 }} />
            </colgroup>
            <thead>
              <tr
                className="sticky top-0 text-left"
                style={{ backgroundColor: "var(--kf-bg-secondary)", borderBottom: "1px solid var(--kf-border)" }}
              >
                <th className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.size === entries.length}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-2 py-1.5" style={{ color: "var(--kf-text-muted)" }}>{t("trashBrowser.colName")}</th>
                <th className="px-2 py-1.5 text-right" style={{ color: "var(--kf-text-muted)" }}>{t("trashBrowser.colSize")}</th>
                <th className="px-2 py-1.5" style={{ color: "var(--kf-text-muted)" }}>{t("trashBrowser.colDeletedAt")}</th>
                <th className="px-2 py-1.5" style={{ color: "var(--kf-text-muted)" }}>{t("trashBrowser.colOriginalPath")}</th>
                <th className="px-2 py-1.5 text-right" style={{ color: "var(--kf-text-muted)" }}>{t("trashBrowser.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isSel = selected.has(entry.original_path);
                return (
                  <tr
                    key={entry.original_path}
                    className="border-b hover:opacity-80 cursor-pointer"
                    style={{
                      borderColor: "var(--kf-border-soft)",
                      backgroundColor: isSel ? "color-mix(in srgb, var(--kf-accent) 15%, transparent)" : undefined,
                    }}
                    onClick={() => toggleSelect(entry.original_path)}
                  >
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleSelect(entry.original_path)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-2 py-1.5 overflow-hidden">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Icon
                          name={entry.is_dir ? "folder" : "insert_drive_file"}
                          size={14}
                          style={{ color: entry.is_dir ? "#fbbf24" : "var(--kf-text-muted)", flexShrink: 0 }}
                        />
                        <span className="truncate" style={{ color: "var(--kf-text-primary)" }}>{entry.name}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right" style={{ color: "var(--kf-text-muted)" }}>
                      {formatSize(entry.size)}
                    </td>
                    <td className="px-2 py-1.5" style={{ color: "var(--kf-text-muted)" }}>
                      {formatDate(entry.deleted_at)}
                    </td>
                    <td
                      className="px-2 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap"
                      style={{ color: "var(--kf-text-muted)" }}
                      title={entry.original_path}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setPathMenu({ x: e.clientX, y: e.clientY, path: entry.original_path });
                      }}
                    >
                      {entry.original_path}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); restore([entry.original_path]); }}
                          disabled={busy}
                          className="flex items-center gap-1.5 px-2 py-1 rounded disabled:opacity-30 hover:opacity-80"
                          style={{ border: "1px solid currentColor", color: "var(--kf-accent)" }}
                          title={t("trashBrowser.restore")}
                        >
                          <Icon name="restore_from_trash" size={16} />
                          <span>{t("trashBrowser.restore")}</span>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); purge([entry.original_path]); }}
                          disabled={busy}
                          className="flex items-center gap-1.5 px-2 py-1 rounded disabled:opacity-30 hover:opacity-80"
                          style={{ border: "1px solid currentColor", color: "var(--kf-error)" }}
                          title={t("trashBrowser.deletePermanently")}
                        >
                          <Icon name="delete_forever" size={16} />
                          <span>{t("common.delete")}</span>
                        </button>
                      </div>
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
        className="px-3 py-1 shrink-0 border-t"
        style={{ borderColor: "var(--kf-border)", color: "var(--kf-text-muted)", backgroundColor: "var(--kf-bg-secondary)" }}
      >
        {t("statusBar.itemCount", { count: entries.length })}
      </div>

      {/* Path context menu */}
      {pathMenu && (
        <div
          ref={pathMenuRef}
          className="kf-surface-menu fixed z-50 text-xs py-1"
          style={{
            left: pathMenuPos.x,
            top: pathMenuPos.y,
            color: "var(--kf-text-primary)",
            minWidth: 160,
          }}
        >
          <div
            className="px-2 py-0.5 truncate text-[10px]"
            style={{ color: "var(--kf-text-muted)", maxWidth: 320 }}
            title={pathMenu.path}
          >
            {pathMenu.path}
          </div>
          <div style={{ borderTop: "1px solid var(--kf-border)", margin: "2px 0" }} />
          <button
            className="kf-menu-item flex items-center gap-2 w-full px-2.5 mx-1 text-left"
            onClick={() => {
              navigator.clipboard.writeText(pathMenu.path);
              setPathMenu(null);
            }}
          >
            <Icon name="content_copy" size={13} style={{ color: "var(--kf-text-muted)" }} />
            {t("fileList.copyPath")}
          </button>
        </div>
      )}
    </div>
  );
}
