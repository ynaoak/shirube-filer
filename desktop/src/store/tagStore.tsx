import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { remapPathMap, removePathsFromMap } from "../lib/pathMetadata";

/** Maps an absolute file path to its list of tags. */
export type TagMap = Record<string, string[]>;

type TagContextValue = {
  /** path → tags map */
  tags: TagMap;
  /** Tags for a single path (empty array if none). */
  getTags: (path: string) => string[];
  /** Replace the full tag list for a path. Empty list removes the entry. */
  setFileTags: (path: string, tags: string[]) => void;
  /** Add one tag to a path (no-op if already present). */
  addTag: (path: string, tag: string) => void;
  /** Remove one tag from a path. */
  removeTag: (path: string, tag: string) => void;
  /** All distinct tags across every path, with usage counts, sorted by name. */
  allTags: Array<{ tag: string; count: number }>;
  /** 移動/リネームに追従してタグの紐づけ先を付け替える（配下も含む）。 */
  movePath: (from: string, to: string) => void;
  /** 削除されたパスのタグを捨てる（フォルダなら配下も）。 */
  removePaths: (paths: string[]) => void;
};

const TagContext = createContext<TagContextValue | null>(null);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(next: TagMap) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_tags", { tags: next }).catch(() => {});
  }, 400);
}

/** Normalize a tag: trim and collapse internal whitespace. */
function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function TagProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagMap>({});

  // Load the tag map from the backend on mount.
  useEffect(() => {
    invoke<TagMap | null>("load_tags")
      .then((loaded) => {
        if (loaded) setTags(loaded);
      })
      .catch(() => {});
  }, []);

  const getTags = useCallback((path: string) => tags[path] ?? [], [tags]);

  const setFileTags = useCallback((path: string, list: string[]) => {
    setTags((prev) => {
      const cleaned = Array.from(
        new Set(list.map(normalizeTag).filter((t) => t.length > 0))
      );
      const next = { ...prev };
      if (cleaned.length === 0) {
        delete next[path];
      } else {
        next[path] = cleaned;
      }
      persist(next);
      return next;
    });
  }, []);

  const addTag = useCallback((path: string, tag: string) => {
    const clean = normalizeTag(tag);
    if (!clean) return;
    setTags((prev) => {
      const current = prev[path] ?? [];
      if (current.includes(clean)) return prev;
      const next = { ...prev, [path]: [...current, clean] };
      persist(next);
      return next;
    });
  }, []);

  const removeTag = useCallback((path: string, tag: string) => {
    setTags((prev) => {
      const current = prev[path];
      if (!current || !current.includes(tag)) return prev;
      const filtered = current.filter((t) => t !== tag);
      const next = { ...prev };
      if (filtered.length === 0) delete next[path];
      else next[path] = filtered;
      persist(next);
      return next;
    });
  }, []);

  const movePath = useCallback((from: string, to: string) => {
    setTags((prev) => {
      const next = remapPathMap(prev, from, to);
      if (next === prev) return prev;
      persist(next);
      return next;
    });
  }, []);

  const removePaths = useCallback((paths: string[]) => {
    setTags((prev) => {
      const next = removePathsFromMap(prev, paths);
      if (next === prev) return prev;
      persist(next);
      return next;
    });
  }, []);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const list of Object.values(tags)) {
      for (const t of list) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [tags]);

  const value: TagContextValue = {
    tags,
    getTags,
    setFileTags,
    addTag,
    removeTag,
    allTags,
    movePath,
    removePaths,
  };

  return <TagContext.Provider value={value}>{children}</TagContext.Provider>;
}

export function useTags(): TagContextValue {
  const ctx = useContext(TagContext);
  if (!ctx) throw new Error("useTags must be used within TagProvider");
  return ctx;
}
