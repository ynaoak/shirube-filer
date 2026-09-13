import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";

/** 1 つのルール条件。空フィールドは「絞らない」を意味する。 */
export type RuleConditions = {
  /** 拡張子（ドットなし小文字）の集合。空配列なら無条件。 */
  extensions?: string[];
  /** 簡易 glob（`*` のみ、大小無視）。空文字なら無条件。 */
  namePattern?: string | null;
  /** バイト数下限（ファイルのみ）。 */
  minSize?: number | null;
};

/** ルールアクション。move は watchPath/<destSubdir>/ へ移動する。 */
export type RuleAction =
  | { type: "move"; destSubdir: string }
  | { type: "addTag"; tag: string }
  | { type: "setLabel"; color: string };

export type AutomationRule = {
  id: string;
  name: string;
  enabled: boolean;
  /** fs:changed 検知で自動実行する。false なら手動実行のみ。 */
  autoRun: boolean;
  watchPath: string;
  conditions: RuleConditions;
  actions: RuleAction[];
};

type RuleContextValue = {
  rules: AutomationRule[];
  loaded: boolean;
  addRule: (rule: AutomationRule) => void;
  updateRule: (id: string, patch: Partial<AutomationRule>) => void;
  removeRule: (id: string) => void;
  reorderRule: (id: string, direction: "up" | "down") => void;
};

const RuleContext = createContext<RuleContextValue | null>(null);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(next: AutomationRule[]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_rules", { rules: next }).catch(() => {});
  }, 400);
}

/** destSubdir のサニタイズ: パスセパレータ・`..` を含む値を弾く。 */
export function isValidDestSubdir(name: string): boolean {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("\0")) return false;
  return true;
}

/** ファイル名と簡易 glob (`*` のみ) のマッチ判定。大小無視。 */
export function matchGlob(pattern: string, name: string): boolean {
  if (!pattern) return true;
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name.toLowerCase());
}

export function newRule(watchPath = ""): AutomationRule {
  return {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    name: "新しいルール",
    enabled: true,
    autoRun: false,
    watchPath,
    conditions: { extensions: [], namePattern: null, minSize: null },
    actions: [],
  };
}

export function RuleProvider({ children }: { children: ReactNode }) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    invoke<AutomationRule[]>("load_rules")
      .then((r) => {
        if (Array.isArray(r)) setRules(r);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const addRule = useCallback((rule: AutomationRule) => {
    setRules((prev) => {
      const next = [...prev, rule];
      persist(next);
      return next;
    });
  }, []);

  const updateRule = useCallback((id: string, patch: Partial<AutomationRule>) => {
    setRules((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
      persist(next);
      return next;
    });
  }, []);

  const removeRule = useCallback((id: string) => {
    setRules((prev) => {
      const next = prev.filter((r) => r.id !== id);
      persist(next);
      return next;
    });
  }, []);

  const reorderRule = useCallback((id: string, direction: "up" | "down") => {
    setRules((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx === -1) return prev;
      const swapWith = direction === "up" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      persist(next);
      return next;
    });
  }, []);

  return (
    <RuleContext.Provider
      value={{ rules, loaded, addRule, updateRule, removeRule, reorderRule }}
    >
      {children}
    </RuleContext.Provider>
  );
}

export function useRules(): RuleContextValue {
  const ctx = useContext(RuleContext);
  if (!ctx) throw new Error("useRules must be used within RuleProvider");
  return ctx;
}
