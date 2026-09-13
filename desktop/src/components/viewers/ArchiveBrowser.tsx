import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";

type ArchiveEntry = {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
};

type Props = {
  archivePath: string;
  onClose: () => void;
};

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArchiveBrowser({ archivePath, onClose }: Props) {
  const { t } = useTranslation();
  const dialogRef = useModal<HTMLDivElement>({ onClose });
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPrefix, setCurrentPrefix] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setLoading(true);
    setError(null);
    invoke<ArchiveEntry[]>("list_archive", { path: archivePath })
      .then(setEntries)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [archivePath]);

  // Entries directly under currentPrefix (one level only)
  const visibleEntries = useMemo(() => {
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return entries.filter((e) => e.path.toLowerCase().includes(q));
    }
    return entries.filter((e) => {
      const relative = e.path.slice(currentPrefix.length);
      if (!relative) return false;
      const parts = relative.split("/").filter(Boolean);
      // Direct child: only one part remaining (or directory prefix itself)
      return parts.length === 1 || (parts.length === 2 && parts[1] === "");
    });
  }, [entries, currentPrefix, searchQuery]);

  const archiveName = archivePath.split(/[\\/]/).pop() ?? archivePath;

  // Breadcrumb segments from currentPrefix
  const breadcrumbs = currentPrefix
    .split("/")
    .filter(Boolean);

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("archiveBrowser.title", "アーカイブ")}
        className="kf-anim-scale rounded-lg shadow-xl flex flex-col text-xs"
        style={{
          width: 560,
          maxHeight: "80vh",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-2 border-b shrink-0 font-semibold"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <Icon name="folder_zip" size={14} style={{ color: "var(--kf-accent)" }} />
          <span className="flex-1 truncate">{archiveName}</span>
          <button aria-label={t("common.close")} onClick={onClose} className="opacity-50 hover:opacity-100">
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* Breadcrumb + search */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          {/* Breadcrumb */}
          <div className="flex items-center gap-0.5 flex-1 overflow-x-auto">
            <button
              onClick={() => setCurrentPrefix("")}
              className="hover:underline"
              style={{ color: "var(--kf-accent)" }}
            >
              /
            </button>
            {breadcrumbs.map((seg, i) => {
              const prefix = breadcrumbs.slice(0, i + 1).join("/") + "/";
              return (
                <span key={i} className="flex items-center gap-0.5">
                  <span style={{ color: "var(--kf-text-muted)" }}>/</span>
                  <button
                    onClick={() => setCurrentPrefix(prefix)}
                    className="hover:underline"
                    style={{ color: "var(--kf-accent)" }}
                  >
                    {seg}
                  </button>
                </span>
              );
            })}
          </div>
          {/* Search */}
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("archiveBrowser.filterPlaceholder")}
            className="bg-transparent outline-none text-xs"
            style={{
              border: "1px solid var(--kf-border)",
              borderRadius: 4,
              padding: "1px 6px",
              color: "var(--kf-text-primary)",
              width: 100,
            }}
          />
        </div>

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-20 gap-2" style={{ color: "var(--kf-text-muted)" }}>
              <Icon name="progress_activity" size={16} className="animate-spin" /> {t("common.loading")}
            </div>
          )}
          {error && (
            <div className="px-4 py-3 text-red-400">{error}</div>
          )}
          {!loading && !error && (
            <>
              {/* Go up */}
              {currentPrefix && (
                <div
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b"
                  style={{ borderColor: "var(--kf-border-soft)" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                  onClick={() => {
                    const parts = currentPrefix.split("/").filter(Boolean);
                    setCurrentPrefix(parts.slice(0, -1).join("/") + (parts.length > 1 ? "/" : ""));
                  }}
                >
                  <Icon name="arrow_upward" size={13} style={{ color: "var(--kf-text-muted)" }} />
                  <span style={{ color: "var(--kf-text-muted)" }}>..</span>
                </div>
              )}
              {visibleEntries.length === 0 && (
                <div className="flex items-center justify-center h-16" style={{ color: "var(--kf-text-muted)" }}>
                  {t("archiveBrowser.emptyDir")}
                </div>
              )}
              {visibleEntries.map((entry) => (
                <div
                  key={entry.path}
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b"
                  style={{ borderColor: "var(--kf-border-soft)" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                  onDoubleClick={() => {
                    if (entry.isDir) setCurrentPrefix(entry.path.endsWith("/") ? entry.path : entry.path + "/");
                  }}
                  title={entry.path}
                >
                  <Icon
                    name={entry.isDir ? "folder" : "description"}
                    size={14}
                    style={{ color: entry.isDir ? "var(--kf-accent)" : "var(--kf-text-muted)", flexShrink: 0 }}
                  />
                  <span className="flex-1 truncate">{entry.name}</span>
                  {!entry.isDir && (
                    <span style={{ color: "var(--kf-text-muted)" }}>{formatSize(entry.size)}</span>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-1.5 border-t shrink-0"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)", color: "var(--kf-text-muted)" }}
        >
          <span>{t("previewPanel.archiveEntryCount", { count: entries.length })}</span>
          <button
            onClick={onClose}
            className="kf-btn kf-btn-secondary"
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
