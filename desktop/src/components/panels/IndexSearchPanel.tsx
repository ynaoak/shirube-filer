import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Icon from "../common/Icon";

type IndexHit = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  extension: string | null;
};

type IndexStatus = {
  building: boolean;
  count: number;
  indexedAt: number | null;
  roots: string[];
};

type Props = {
  /** パネル右上の × から閉じる（ActivityBar のトグルと同じ導線） */
  onClose?: () => void;
  currentPath: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
};

const MAX_RESULTS = 500;

function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

function formatTime(secs: number | null): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function IndexSearchPanel({ currentPath, onNavigate, onOpenFile, onClose }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IndexHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [status, setStatus] = useState<IndexStatus>({ building: false, count: 0, indexedAt: null, roots: [] });
  const [progress, setProgress] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await invoke<IndexStatus | null>("index_status");
      // バックエンドが null / 欠損フィールドを返してもクラッシュしない
      if (s && typeof s === "object") {
        setStatus({
          building: !!s.building,
          count: s.count ?? 0,
          indexedAt: s.indexedAt ?? null,
          roots: s.roots ?? [],
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Subscribe to backend index events (progress / done).
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let active = true;
    (async () => {
      const p = await listen<number>("index:progress", (e) => setProgress(e.payload));
      const d = await listen<number>("index:done", () => {
        setProgress(null);
        refreshStatus();
      });
      if (active) {
        unlistens.push(p, d);
      } else {
        p();
        d();
      }
    })();
    return () => {
      active = false;
      unlistens.forEach((fn) => fn());
    };
  }, [refreshStatus]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    try {
      const res = await invoke<IndexHit[]>("search_index", {
        query: q,
        maxResults: MAX_RESULTS,
        dirsOnly: false,
      });
      setResults(res);
    } catch {
      setResults([]);
    } finally {
      // Always clear loading — success, empty, or error.
      setLoading(false);
      setSearched(true);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(val), 150);
  };

  const buildIndex = useCallback(async () => {
    let roots: string[] = currentPath ? [currentPath] : [];
    if (roots.length === 0) {
      try {
        const home = await invoke<string>("get_home_dir");
        if (home) roots = [home];
      } catch {
        /* ignore */
      }
    }
    if (roots.length === 0) return;
    setStatus((s) => ({ ...s, building: true }));
    setProgress(0);
    try {
      await invoke<number>("build_index", { roots });
    } catch {
      /* error: fall through to status refresh */
    } finally {
      setProgress(null);
      refreshStatus();
      if (query.trim()) runSearch(query);
    }
  }, [currentPath, query, runSearch, refreshStatus]);

  const handleClickHit = (hit: IndexHit) => {
    if (hit.isDir) {
      onNavigate(hit.path);
    } else {
      onNavigate(parentDir(hit.path));
      onOpenFile(hit.path);
    }
  };

  return (
    <div
      className="w-72 flex-shrink-0 flex flex-col border-l text-xs overflow-hidden"
      style={{
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* Header: search input */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="travel_explore" size={14} style={{ color: "var(--kf-text-muted)" }} />
        <input
          value={query}
          onChange={handleChange}
          placeholder={t("indexSearch.placeholder")}
          className="flex-1 bg-transparent outline-none text-xs"
          style={{ color: "var(--kf-text-primary)" }}
          autoFocus
        />
        {loading && (
          <Icon name="progress_activity" size={13} className="animate-spin" style={{ color: "var(--kf-accent)" }} />
        )}
        {!loading && query && (
          <button onClick={() => { setQuery(""); setResults([]); setSearched(false); }} style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="close" size={12} />
          </button>
        )}
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

      {/* Status / index controls */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border-soft)", color: "var(--kf-text-muted)" }}
      >
        <span className="flex-1 truncate">
          {status.building || progress !== null
            ? t("indexSearch.building", { count: progress != null ? progress.toLocaleString() : "" })
            : status.count > 0
              ? t("indexSearch.status", { count: status.count.toLocaleString(), time: formatTime(status.indexedAt) })
              : t("indexSearch.notBuilt")}
        </span>
        <button
          onClick={buildIndex}
          disabled={status.building || progress !== null}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded"
          style={{
            color: "var(--kf-accent)",
            opacity: status.building || progress !== null ? 0.5 : 1,
          }}
          title={currentPath ? t("indexSearch.targetCurrent", { path: currentPath }) : t("indexSearch.targetHome")}
        >
          <Icon name="refresh" size={12} />
          {status.count > 0 ? t("indexSearch.rebuild") : t("indexSearch.build")}
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {status.count === 0 && !status.building && progress === null && (
          <div className="flex flex-col items-center justify-center h-24 gap-1 px-4 text-center" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="travel_explore" size={20} />
            <span>{t("indexSearch.emptyHint")}</span>
          </div>
        )}
        {status.count > 0 && !searched && (
          <div className="flex flex-col items-center justify-center h-20 gap-1" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="search" size={20} />
            <span>{t("indexSearch.enterKeyword")}</span>
          </div>
        )}
        {searched && results.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-20 gap-1" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="search_off" size={20} />
            <span>{t("indexSearch.noMatch")}</span>
          </div>
        )}
        {results.map((hit) => (
          <div
            key={hit.path}
            className="flex items-center gap-2 px-3 py-1 cursor-pointer"
            style={{ borderBottom: "1px solid var(--kf-border-soft)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
            onClick={() => handleClickHit(hit)}
            title={hit.path}
          >
            <Icon
              name={hit.isDir ? "folder" : "description"}
              size={13}
              style={{ flexShrink: 0, color: hit.isDir ? "var(--kf-accent)" : "var(--kf-text-muted)" }}
            />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate">{hit.name}</span>
              <span className="truncate font-mono" style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>
                {parentDir(hit.path)}
              </span>
            </div>
          </div>
        ))}
        {searched && results.length >= MAX_RESULTS && (
          <div className="px-3 py-2 text-center" style={{ color: "var(--kf-text-muted)" }}>
            {t("indexSearch.tooMany", { max: MAX_RESULTS })}
          </div>
        )}
      </div>
    </div>
  );
}
