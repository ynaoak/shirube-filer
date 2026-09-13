import { createContext, useContext } from "react";
import { FileEntry } from "../types/fs";

export type DiffStatus = "identical" | "modified" | "only-here" | "only-other";

export type CompareContextValue = {
  enabled: boolean;
  /** Register this pane's entries for comparison. FileList calls this when entries change. */
  registerEntries: (paneId: string, entries: FileEntry[]) => void;
  /** paneId → entries map, all file panes */
  paneEntries: Map<string, FileEntry[]>;
  /** Compute diff status for an entry in a given pane relative to another pane */
  getDiffStatus: (paneId: string, entry: FileEntry) => DiffStatus | null;
};

export const CompareContext = createContext<CompareContextValue>({
  enabled: false,
  registerEntries: () => {},
  paneEntries: new Map(),
  getDiffStatus: () => null,
});

export function useCompare() {
  return useContext(CompareContext);
}

export function buildDiffStatus(entry: FileEntry, otherMap: Map<string, FileEntry>): DiffStatus {
  const other = otherMap.get(entry.name.toLowerCase());
  if (!other) return "only-here";
  if (
    other.size === entry.size &&
    other.modified === entry.modified &&
    other.isDir === entry.isDir
  ) {
    return "identical";
  }
  return "modified";
}
