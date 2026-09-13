import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileEntry } from "../types/fs";
import { FilterPreset, SortDir, SortKey } from "../types/fileListTypes";
import { APP_EVENTS } from "../lib/appEvents";
import { useUiSettings } from "../store/uiSettingsStore";
import { useColorLabels } from "../store/colorLabelStore";

export const PRESET_EXTS: Record<Exclude<FilterPreset, "all" | "folders">, Set<string>> = {
  images:    new Set(["jpg","jpeg","png","gif","webp","svg","bmp","tiff","ico","avif","heic"]),
  code:      new Set(["ts","tsx","js","jsx","rs","py","go","java","c","cpp","h","cs","rb","php","swift","kt","vue","sh","bash","zsh"]),
  text:      new Set(["txt","md","pdf","rtf","csv","odt"]),
  archives:  new Set(["zip","tar","gz","bz2","xz","7z","rar","zst"]),
  microsoft: new Set(["doc","docx","xls","xlsx","ppt","pptx"]),
};

export const COLOR_LABEL_COLORS = ["#ef4444","#f97316","#eab308","#22c55e","#3b82f6","#a855f7"] as const;
export const COLOR_LABEL_NAMES = ["colorLabels.red","colorLabels.orange","colorLabels.yellow","colorLabels.green","colorLabels.blue","colorLabels.purple"] as const;

export type GrepMatch = {
  path: string;
  lineNumber: number;
  line: string;
};

type UseFileFilterArgs = {
  entries: FileEntry[];
  currentPath: string;
  tabId: string;
};

type SearchMode = "local" | "recursive" | "content";
type PersistedSearch = { query: string; mode: SearchMode };

const searchStateKey = (tabId: string) => `kf-search-${tabId}`;

/**
 * 検索語が拡張子検索（`*.md` / `ext:md` 形式）なら拡張子（小文字・ドットなし）を
 * 返す。それ以外は null（従来どおりファイル名の部分一致）。
 * 素の `.md` は拡張子検索にしない — `.git` のようなドットファイル名の部分一致
 * 検索を壊さないため。
 */
export function parseExtQuery(query: string): string | null {
  const q = query.trim().toLowerCase();
  const m = q.match(/^(?:\*\.|ext:\.?)([a-z0-9][a-z0-9._-]*)$/);
  return m ? m[1] : null;
}

/**
 * 検索条件はタブ単位で保存する。
 * クリック時のプレビュー表示（ペイン分割）やタブ切替で FileList が再マウントされても
 * 入力した検索語が消えないようにするため。ウィンドウを閉じれば消える sessionStorage に
 * 置き、次回起動には持ち越さない。
 */
function loadSearchState(tabId: string): PersistedSearch {
  try {
    const raw = sessionStorage.getItem(searchStateKey(tabId));
    if (!raw) return { query: "", mode: "local" };
    const parsed = JSON.parse(raw) as Partial<PersistedSearch>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      mode: parsed.mode === "recursive" || parsed.mode === "content" ? parsed.mode : "local",
    };
  } catch {
    return { query: "", mode: "local" };
  }
}

export type UseFileFilterReturn = {
  // Search
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  searchMode: "local" | "recursive" | "content";
  setSearchMode: React.Dispatch<React.SetStateAction<"local" | "recursive" | "content">>;
  recursiveResults: FileEntry[];
  recursiveLoading: boolean;
  cancelSearch: () => void;
  grepResults: GrepMatch[];
  grepLoading: boolean;
  cancelGrepSearch: () => void;
  // Preset & advanced filter
  filterPreset: FilterPreset;
  setFilterPreset: React.Dispatch<React.SetStateAction<FilterPreset>>;
  /** カラーラベルの絞り込み。null = 絞り込みなし、hex = その色だけ表示。 */
  labelFilter: string | null;
  setLabelFilter: React.Dispatch<React.SetStateAction<string | null>>;
  showAdvFilter: boolean;
  setShowAdvFilter: React.Dispatch<React.SetStateAction<boolean>>;
  sizeMin: string;
  setSizeMin: React.Dispatch<React.SetStateAction<string>>;
  sizeMax: string;
  setSizeMax: React.Dispatch<React.SetStateAction<string>>;
  sizeUnit: "KB" | "MB";
  setSizeUnit: React.Dispatch<React.SetStateAction<"KB" | "MB">>;
  dateMin: string;
  setDateMin: React.Dispatch<React.SetStateAction<string>>;
  dateMax: string;
  setDateMax: React.Dispatch<React.SetStateAction<string>>;
  // Visibility
  showHidden: boolean;
  // Sort
  sortKey: SortKey;
  sortDir: SortDir;
  handleSort: (col: SortKey) => void;
  // Pin
  pinnedPaths: Set<string>;
  handleTogglePin: (paths: string[]) => void;
  // Derived
  filteredEntries: FileEntry[];
  displayEntries: FileEntry[];
  isRecursiveActive: boolean;
  isContentActive: boolean;
};

export function useFileFilter({ entries, currentPath, tabId }: UseFileFilterArgs): UseFileFilterReturn {
  const [initialSearch] = useState(() => loadSearchState(tabId));
  const [searchQuery, setSearchQuery] = useState(initialSearch.query);
  const [searchMode, setSearchMode] = useState<SearchMode>(initialSearch.mode);
  const [recursiveResults, setRecursiveResults] = useState<FileEntry[]>([]);
  const [recursiveLoading, setRecursiveLoading] = useState(false);
  const [grepResults, setGrepResults] = useState<GrepMatch[]>([]);
  const [grepLoading, setGrepLoading] = useState(false);

  const [filterPreset, setFilterPreset] = useState<FilterPreset>("all");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const { colorLabels } = useColorLabels();
  const [showAdvFilter, setShowAdvFilter] = useState(false);
  const [sizeMin, setSizeMin] = useState("");
  const [sizeMax, setSizeMax] = useState("");
  const [sizeUnit, setSizeUnit] = useState<"KB" | "MB">("MB");
  const [dateMin, setDateMin] = useState("");
  const [dateMax, setDateMax] = useState("");

  const [{ showHiddenFiles }] = useUiSettings();
  const showHidden = showHiddenFiles;

  const [sortKey, setSortKey] = useState<SortKey>(() => (localStorage.getItem(`kf-sort-key-${tabId}`) as SortKey) ?? "name");
  const [sortDir, setSortDir] = useState<SortDir>(() => (localStorage.getItem(`kf-sort-dir-${tabId}`) as SortDir) ?? "asc");

  const [pinnedPaths, setPinnedPaths] = useState<Set<string>>(new Set());

  const recursiveAbortRef = useRef(false);
  const grepAbortRef = useRef(false);
  // 走査をバックエンドごと打ち切るためのトークン（タブ単位）。
  // フロントで結果を捨てるだけでは、再帰検索・grep はディスクを掘り続けてしまい、
  // 検索をやめて別パスへ移動しても移動先の読み込みが待たされる。
  const scanTokenRef = useRef(`filefilter:${tabId}`);

  const cancelBackendScan = useCallback(() => {
    invoke("cancel_scan", { token: scanTokenRef.current }).catch(() => {});
  }, []);

  const cancelSearch = useCallback(() => {
    recursiveAbortRef.current = true;
    cancelBackendScan();
    setRecursiveLoading(false);
    setRecursiveResults([]);
  }, [cancelBackendScan]);

  const cancelGrepSearch = useCallback(() => {
    grepAbortRef.current = true;
    cancelBackendScan();
    setGrepLoading(false);
    setGrepResults([]);
  }, [cancelBackendScan]);

  // Load pinned paths for current directory
  useEffect(() => {
    const raw = localStorage.getItem(`kf-pinned-${currentPath}`);
    const parsed: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    setPinnedPaths((prev) => {
      if (prev.size === parsed.length && parsed.every((p) => prev.has(p))) return prev;
      return new Set(parsed);
    });
  }, [currentPath]);

  // 検索語・検索モードをタブ単位で保存（再マウントされても復元できるようにする）
  useEffect(() => {
    try {
      if (!searchQuery) sessionStorage.removeItem(searchStateKey(tabId));
      else sessionStorage.setItem(searchStateKey(tabId), JSON.stringify({ query: searchQuery, mode: searchMode }));
    } catch {
      // ストレージが使えない環境では保存しない（検索自体は動く）
    }
  }, [tabId, searchQuery, searchMode]);

  // Recursive search
  useEffect(() => {
    if (searchMode !== "recursive" || !searchQuery.trim()) {
      setRecursiveResults([]);
      return;
    }
    recursiveAbortRef.current = false;
    setRecursiveLoading(true);
    const t = setTimeout(async () => {
      try {
        // 拡張子検索（*.md / ext:md）: バックエンドは名前の部分一致なので
        // ".md" を投げて候補を絞り、返ってきた結果を拡張子で厳密に絞り込む。
        const extQ = parseExtQuery(searchQuery);
        const results = await invoke<FileEntry[]>("search_files", {
          root: currentPath,
          query: extQ ? `.${extQ}` : searchQuery.trim(),
          maxResults: 200,
          scanToken: scanTokenRef.current,
        });
        const narrowed = extQ
          ? results.filter((e) => {
              if (e.isDir) return false;
              if (extQ.includes(".")) return e.name.toLowerCase().endsWith(`.${extQ}`);
              return (e.extension ?? "").toLowerCase() === extQ;
            })
          : results;
        if (!recursiveAbortRef.current) setRecursiveResults(narrowed);
      } catch (e) {
        // 中断した走査のエラーはノイズなので出さない
        if (!recursiveAbortRef.current) console.error("[search_files]", e);
      } finally {
        if (!recursiveAbortRef.current) setRecursiveLoading(false);
      }
    }, 300);
    return () => {
      recursiveAbortRef.current = true;
      // 入力が進んだ・フォルダを移動した時点で、前の走査をバックエンドごと止める
      cancelBackendScan();
      clearTimeout(t);
      setRecursiveLoading(false);
    };
  }, [searchMode, searchQuery, currentPath, cancelBackendScan]);

  // Content (grep) search
  useEffect(() => {
    if (searchMode !== "content" || !searchQuery.trim()) {
      setGrepResults([]);
      return;
    }
    grepAbortRef.current = false;
    setGrepLoading(true);
    const t = setTimeout(async () => {
      try {
        const results = await invoke<GrepMatch[]>("grep_files", {
          root: currentPath,
          pattern: searchQuery.trim(),
          maxResults: 500,
          scanToken: scanTokenRef.current,
        });
        if (!grepAbortRef.current) setGrepResults(results);
      } catch (e) {
        if (!grepAbortRef.current) console.error("[grep_files]", e);
      } finally {
        if (!grepAbortRef.current) setGrepLoading(false);
      }
    }, 500);
    return () => {
      grepAbortRef.current = true;
      cancelBackendScan();
      clearTimeout(t);
      setGrepLoading(false);
    };
  }, [searchMode, searchQuery, currentPath, cancelBackendScan]);

  // Broadcast search query changes for BookmarkPanel (debounced, skip initial mount)
  const searchBroadcastMounted = useRef(false);
  useEffect(() => {
    if (!searchBroadcastMounted.current) { searchBroadcastMounted.current = true; return; }
    const timer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent(APP_EVENTS.SEARCH_CHANGED, { detail: { query: searchQuery } }));
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Apply saved query from BookmarkPanel
  useEffect(() => {
    const handler = (e: Event) => {
      const { query } = (e as CustomEvent).detail as { query: string };
      setSearchQuery(query);
    };
    window.addEventListener(APP_EVENTS.APPLY_SAVED_QUERY, handler);
    return () => window.removeEventListener(APP_EVENTS.APPLY_SAVED_QUERY, handler);
  }, []);

  const handleSort = useCallback((col: SortKey) => {
    if (col === sortKey) {
      const next = sortDir === "asc" ? "desc" : "asc";
      setSortDir(next);
      localStorage.setItem(`kf-sort-dir-${tabId}`, next);
    } else {
      setSortKey(col);
      setSortDir("asc");
      localStorage.setItem(`kf-sort-key-${tabId}`, col);
      localStorage.setItem(`kf-sort-dir-${tabId}`, "asc");
    }
  }, [sortKey, sortDir, tabId]);

  const handleTogglePin = useCallback((paths: string[]) => {
    setPinnedPaths((prev) => {
      const next = new Set(prev);
      const allPinned = paths.every((p) => next.has(p));
      if (allPinned) paths.forEach((p) => next.delete(p));
      else paths.forEach((p) => next.add(p));
      localStorage.setItem(`kf-pinned-${currentPath}`, JSON.stringify(Array.from(next)));
      return next;
    });
  }, [currentPath]);


  const filteredEntries = useMemo(() => {
    let list = entries;

    if (!showHidden) {
      list = list.filter((e) => !e.isHidden);
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const extQ = parseExtQuery(q);
      if (extQ) {
        // 拡張子検索（*.md / ext:md）: 拡張子の完全一致。"tar.gz" のような
        // 複合拡張子は extension フィールド（最終セグメントのみ）に入らないため
        // ファイル名の末尾一致で判定する。フォルダは対象外。
        list = list.filter((e) => {
          if (e.isDir) return false;
          if (extQ.includes(".")) return e.name.toLowerCase().endsWith(`.${extQ}`);
          return (e.extension ?? "").toLowerCase() === extQ;
        });
      } else {
        list = list.filter((e) => e.name.toLowerCase().includes(q));
      }
    }

    if (filterPreset !== "all") {
      if (filterPreset === "folders") {
        list = list.filter((e) => e.isDir);
      } else {
        // ファイル種別フィルタ（画像/コード/テキスト等）ではフォルダを除外する
        const exts = PRESET_EXTS[filterPreset];
        list = list.filter((e) => !e.isDir && exts.has((e.extension ?? "").toLowerCase()));
      }
    }

    // カラーラベルの絞り込み。ラベルはパス単位で保存している。
    if (labelFilter) {
      list = list.filter((e) => colorLabels[e.path] === labelFilter);
    }

    const unitBytes = sizeUnit === "KB" ? 1024 : 1024 * 1024;
    const sizeMinBytes = sizeMin !== "" ? parseFloat(sizeMin) * unitBytes : null;
    const sizeMaxBytes = sizeMax !== "" ? parseFloat(sizeMax) * unitBytes : null;
    if (sizeMinBytes !== null || sizeMaxBytes !== null) {
      list = list.filter((e) => {
        if (e.isDir) return true;
        const sz = e.size ?? 0;
        if (sizeMinBytes !== null && sz < sizeMinBytes) return false;
        if (sizeMaxBytes !== null && sz > sizeMaxBytes) return false;
        return true;
      });
    }

    const parseDateLocal = (s: string, endOfDay: boolean) => {
      const [y, m, d] = s.split("-").map(Number);
      return new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0).getTime() / 1000;
    };
    const dateMinTs = dateMin !== "" ? parseDateLocal(dateMin, false) : null;
    const dateMaxTs = dateMax !== "" ? parseDateLocal(dateMax, true) : null;
    if (dateMinTs !== null || dateMaxTs !== null) {
      list = list.filter((e) => {
        const mod = e.modified ?? 0;
        if (dateMinTs !== null && mod < dateMinTs) return false;
        if (dateMaxTs !== null && mod > dateMaxTs) return false;
        return true;
      });
    }

    const sorted = [...list].sort((a, b) => {
      const aPinned = pinnedPaths.has(a.path);
      const bPinned = pinnedPaths.has(b.path);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;

      if (sortKey !== "type" && sortKey !== "ext" && a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      let cmp = 0;
      if (sortKey === "name") {
        cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      } else if (sortKey === "size") {
        cmp = a.size - b.size;
      } else if (sortKey === "modified") {
        cmp = (a.modified ?? 0) - (b.modified ?? 0);
      } else if (sortKey === "ext") {
        cmp = (a.extension ?? "").toLowerCase().localeCompare((b.extension ?? "").toLowerCase());
        if (cmp === 0) cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      } else if (sortKey === "type") {
        const typeRank = (e: typeof a) => {
          if (e.isDir) return 0;
          const ext = (e.extension ?? "").toLowerCase();
          if (PRESET_EXTS.images.has(ext)) return 1;
          if (PRESET_EXTS.code.has(ext)) return 2;
          if (PRESET_EXTS.text.has(ext)) return 3;
          if (PRESET_EXTS.microsoft.has(ext)) return 4;
          if (PRESET_EXTS.archives.has(ext)) return 5;
          return 6;
        };
        cmp = typeRank(a) - typeRank(b);
        if (cmp === 0) cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [entries, showHidden, searchQuery, filterPreset, labelFilter, colorLabels, sortKey, sortDir, pinnedPaths, sizeMin, sizeMax, sizeUnit, dateMin, dateMax]);

  const isRecursiveActive = searchMode === "recursive" && !!searchQuery.trim();
  const isContentActive = searchMode === "content" && !!searchQuery.trim();
  // 再帰検索の結果は filteredEntries を通らない（バックエンドの検索結果をそのまま出す）。
  // ラベルの絞り込みはパス単位で効くものなので、ここでも同じ基準で適用する。
  const displayEntries = useMemo(() => {
    if (!isRecursiveActive) return filteredEntries;
    if (!labelFilter) return recursiveResults;
    return recursiveResults.filter((e) => colorLabels[e.path] === labelFilter);
  }, [isRecursiveActive, filteredEntries, recursiveResults, labelFilter, colorLabels]);

  return {
    searchQuery, setSearchQuery,
    searchMode, setSearchMode,
    recursiveResults, recursiveLoading, cancelSearch,
    grepResults, grepLoading, cancelGrepSearch,
    filterPreset, setFilterPreset,
    labelFilter, setLabelFilter,
    showAdvFilter, setShowAdvFilter,
    sizeMin, setSizeMin,
    sizeMax, setSizeMax,
    sizeUnit, setSizeUnit,
    dateMin, setDateMin,
    dateMax, setDateMax,
    showHidden,
    sortKey, sortDir, handleSort,
    pinnedPaths, handleTogglePin,
    filteredEntries,
    displayEntries,
    isRecursiveActive,
    isContentActive,
  };
}
