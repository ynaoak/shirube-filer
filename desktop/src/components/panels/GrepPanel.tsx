import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import SkeletonList from "../common/SkeletonList";
import Icon from "../common/Icon";

type GrepMatch = {
  path: string;
  lineNumber: number;
  line: string;
};

type Props = {
  /** パネル右上の × から閉じる（ActivityBar のトグルと同じ導線） */
  onClose?: () => void;
  currentPath: string;
  onOpenFile: (path: string) => void;
};

function highlight(line: string, pattern: string): React.ReactNode {
  const idx = line.toLowerCase().indexOf(pattern.toLowerCase());
  if (idx === -1) return line;
  return (
    <>
      {line.slice(0, idx)}
      <span style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)", borderRadius: 2 }}>
        {line.slice(idx, idx + pattern.length)}
      </span>
      {line.slice(idx + pattern.length)}
    </>
  );
}

export default function GrepPanel({ currentPath, onOpenFile, onClose }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GrepMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 走査をバックエンドごと打ち切るためのトークン。
  const scanTokenRef = useRef("greppanel");
  const cancelScan = useCallback(() => {
    invoke("cancel_scan", { token: scanTokenRef.current }).catch(() => {});
  }, []);

  // パネルを閉じた・別フォルダへ移ったときは走査を残さない
  useEffect(() => {
    return () => { cancelScan(); };
  }, [currentPath, cancelScan]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim() || !currentPath) {
      setResults([]);
      setSearched(false);
      return;
    }
    // 前回の走査が残っていれば先に止める（打ち切ってから新しい走査を登録する）
    await invoke("cancel_scan", { token: scanTokenRef.current }).catch(() => {});
    setLoading(true);
    try {
      const res = await invoke<GrepMatch[]>("grep_files", {
        root: currentPath,
        pattern: q,
        maxResults: 200,
        scanToken: scanTokenRef.current,
      });
      setResults(res);
      setSearched(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [currentPath]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(val), 400);
  };

  // Group results by file path
  const byFile = results.reduce<Map<string, GrepMatch[]>>((map, m) => {
    const list = map.get(m.path) ?? [];
    list.push(m);
    map.set(m.path, list);
    return map;
  }, new Map());

  return (
    <div
      className="w-72 flex-shrink-0 flex flex-col border-l text-xs overflow-hidden"
      style={{
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="search" size={14} style={{ color: "var(--kf-text-muted)" }} />
        <input
          value={query}
          onChange={handleChange}
          placeholder={t("grepPanel.searchPlaceholder")}
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

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {loading && results.length === 0 && <SkeletonList rows={7} twoLine />}
        {!searched && !loading && (
          <div className="flex flex-col items-center justify-center h-20 gap-1" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="manage_search" size={20} />
            <span>{t("grepPanel.enterKeyword")}</span>
          </div>
        )}
        {searched && results.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-20 gap-1" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="search_off" size={20} />
            <span>{t("grepPanel.noMatch")}</span>
          </div>
        )}
        {Array.from(byFile.entries()).map(([filePath, matches]) => {
          const relPath = filePath.slice(currentPath.length).replace(/^[\\/]/, "");
          return (
            <div key={filePath}>
              {/* File header */}
              <div
                className="flex items-center gap-1.5 px-3 py-1 sticky top-0 cursor-pointer"
                style={{
                  backgroundColor: "var(--kf-bg-secondary)",
                  borderBottom: "1px solid var(--kf-border-soft)",
                  color: "var(--kf-text-secondary)",
                }}
                onClick={() => onOpenFile(filePath)}
                title={filePath}
              >
                <Icon name="description" size={12} style={{ flexShrink: 0 }} />
                <span className="flex-1 truncate font-mono">{relPath}</span>
                <span style={{ color: "var(--kf-text-muted)" }}>{matches.length}</span>
              </div>
              {/* Matches */}
              {matches.map((m) => (
                <div
                  key={`${m.path}:${m.lineNumber}`}
                  className="flex items-start gap-2 px-3 py-1 cursor-pointer"
                  style={{ borderBottom: "1px solid var(--kf-border-soft)" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                  onClick={() => onOpenFile(filePath)}
                >
                  <span className="font-mono shrink-0" style={{ color: "var(--kf-accent)", minWidth: 28, textAlign: "right" }}>
                    {m.lineNumber}
                  </span>
                  <span className="truncate font-mono" style={{ color: "var(--kf-text-secondary)" }}>
                    {highlight(m.line.trim(), query)}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
        {searched && results.length >= 200 && (
          <div className="px-3 py-2 text-center" style={{ color: "var(--kf-text-muted)" }}>
            {t("grepPanel.tooManyResults")}
          </div>
        )}
      </div>
    </div>
  );
}
