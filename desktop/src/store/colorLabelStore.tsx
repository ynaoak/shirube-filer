import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { remapPathMap, removePathsFromMap } from "../lib/pathMetadata";

/** Maps an absolute file path to a hex color string (e.g. "#ef4444"). */
export type ColorLabelMap = Record<string, string>;

type ColorLabelContextValue = {
  colorLabels: ColorLabelMap;
  getColorLabel: (path: string) => string | undefined;
  /** Set or clear the color label for one or more paths. Pass null to clear. */
  setColorLabel: (paths: string[], color: string | null) => void;
  /** 移動/リネームに追従してラベルの紐づけ先を付け替える（配下も含む）。 */
  movePath: (from: string, to: string) => void;
  /** 削除されたパスのラベルを捨てる（フォルダなら配下も）。 */
  removePaths: (paths: string[]) => void;
};

const ColorLabelContext = createContext<ColorLabelContextValue | null>(null);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(next: ColorLabelMap) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_color_labels", { labels: next }).catch(() => {});
  }, 400);
}

const LEGACY_KEY = "kf-color-labels";

export function ColorLabelProvider({ children }: { children: ReactNode }) {
  const [colorLabels, setColorLabels] = useState<ColorLabelMap>({});

  useEffect(() => {
    const legacy = localStorage.getItem(LEGACY_KEY);
    invoke<ColorLabelMap | null>("load_color_labels")
      .then((loaded) => {
        if (loaded && Object.keys(loaded).length > 0) {
          setColorLabels(loaded);
        } else if (legacy) {
          const migrated = JSON.parse(legacy) as ColorLabelMap;
          setColorLabels(migrated);
          persist(migrated);
        }
        if (legacy) localStorage.removeItem(LEGACY_KEY);
      })
      .catch(() => {
        if (legacy) {
          try {
            setColorLabels(JSON.parse(legacy) as ColorLabelMap);
          } catch {}
          localStorage.removeItem(LEGACY_KEY);
        }
      });
  }, []);

  const getColorLabel = useCallback((path: string) => colorLabels[path], [colorLabels]);

  const setColorLabel = useCallback((paths: string[], color: string | null) => {
    setColorLabels((prev) => {
      const next = { ...prev };
      for (const p of paths) {
        if (color === null) delete next[p];
        else next[p] = color;
      }
      persist(next);
      return next;
    });
  }, []);

  const movePath = useCallback((from: string, to: string) => {
    setColorLabels((prev) => {
      const next = remapPathMap(prev, from, to);
      if (next === prev) return prev;
      persist(next);
      return next;
    });
  }, []);

  const removePaths = useCallback((paths: string[]) => {
    setColorLabels((prev) => {
      const next = removePathsFromMap(prev, paths);
      if (next === prev) return prev;
      persist(next);
      return next;
    });
  }, []);

  const value: ColorLabelContextValue = { colorLabels, getColorLabel, setColorLabel, movePath, removePaths };
  return <ColorLabelContext.Provider value={value}>{children}</ColorLabelContext.Provider>;
}

export function useColorLabels(): ColorLabelContextValue {
  const ctx = useContext(ColorLabelContext);
  if (!ctx) throw new Error("useColorLabels must be used within ColorLabelProvider");
  return ctx;
}
