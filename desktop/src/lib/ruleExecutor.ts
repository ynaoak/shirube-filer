/**
 * 自動化ルール実行エンジン（フロントエンド側）。
 * - 副作用は依存注入されたコールバック経由で行うので、テストや手動実行
 *   （プレビューだけ）にも流用できる。
 * - 安全ガード:
 *   - `move` アクションは watchPath/<destSubdir>/<basename> 固定。
 *     destSubdir は単一階層のサブフォルダ名のみ。
 *   - 既に destSubdir 配下にあるファイルには move を再適用しない（ループ防止）。
 *   - セッション内で同じ (ruleId, path) に複数回処理をしないキャッシュを持つ。
 */
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry, ReadDirResult } from "../types/fs";
import type { AutomationRule, RuleAction } from "../store/ruleStore";
import { isValidDestSubdir, matchGlob } from "../store/ruleStore";

export type RuleExecutorDeps = {
  /** タグ追加（tagStore.addTag をそのまま渡す）。 */
  addTag: (path: string, tag: string) => void;
  /** カラーラベル設定。 */
  setColorLabel: (paths: string[], color: string | null) => void;
  /** 移動にタグ・カラーラベルを追従させる（省略時は追従しない）。 */
  followPathChange?: (from: string, to: string) => void;
};

export type ExecutionLogEntry = {
  ruleId: string;
  path: string;
  action: RuleAction;
  ok: boolean;
  error?: string;
};

/** 1 件のエントリがルール条件にマッチするか判定する。 */
export function matchesRule(rule: AutomationRule, entry: FileEntry): boolean {
  if (entry.isDir) return false; // 現状はファイルのみ対象
  const { extensions, namePattern, minSize } = rule.conditions;
  if (extensions && extensions.length > 0) {
    const ext = (entry.extension ?? "").toLowerCase();
    if (!extensions.includes(ext)) return false;
  }
  if (namePattern && namePattern.trim()) {
    if (!matchGlob(namePattern.trim(), entry.name)) return false;
  }
  if (typeof minSize === "number" && minSize > 0) {
    if (entry.size < minSize) return false;
  }
  return true;
}

/**
 * 1 件のルールを 1 つのディレクトリスキャンに対して適用する。
 * `dryRun=true` のときは副作用を起こさず、マッチ件数とプランだけ返す。
 */
export async function executeRule(
  rule: AutomationRule,
  deps: RuleExecutorDeps,
  options: { dryRun?: boolean; seen?: Set<string> } = {},
): Promise<{ matched: FileEntry[]; log: ExecutionLogEntry[] }> {
  const { dryRun = false, seen } = options;
  if (!rule.enabled) return { matched: [], log: [] };
  if (!rule.watchPath) return { matched: [], log: [] };

  // ディレクトリ列挙
  let entries: FileEntry[] = [];
  try {
    const res = await invoke<ReadDirResult>("read_dir", { path: rule.watchPath });
    entries = res.entries;
  } catch (e) {
    return {
      matched: [],
      log: [{ ruleId: rule.id, path: rule.watchPath, action: rule.actions[0] ?? { type: "addTag", tag: "" }, ok: false, error: String(e) }],
    };
  }

  const matched = entries.filter((e) => matchesRule(rule, e));
  if (dryRun || matched.length === 0) return { matched, log: [] };

  const sep = rule.watchPath.includes("\\") ? "\\" : "/";
  const log: ExecutionLogEntry[] = [];

  for (const entry of matched) {
    // セッション内の重複処理を抑止
    const key = `${rule.id}::${entry.path}`;
    if (seen?.has(key)) continue;

    for (const action of rule.actions) {
      try {
        if (action.type === "move") {
          if (!isValidDestSubdir(action.destSubdir)) {
            log.push({ ruleId: rule.id, path: entry.path, action, ok: false, error: "invalid destSubdir" });
            continue;
          }
          // ループ防止: 既に同じ destSubdir の直下にあるエントリはスキップ
          const parentSep = entry.path.lastIndexOf(sep);
          const parentName = parentSep >= 0
            ? entry.path.slice(0, parentSep).split(/[\\/]/).pop()
            : "";
          if (parentName === action.destSubdir) {
            log.push({ ruleId: rule.id, path: entry.path, action, ok: true });
            continue;
          }
          const destDir = `${rule.watchPath}${sep}${action.destSubdir}`;
          const dest = `${destDir}${sep}${entry.name}`;
          // 移動先ディレクトリが無ければ作成
          await invoke("create_dir", { path: destDir }).catch(() => {});
          await invoke("move_item", { src: entry.path, dest, overwrite: false });
          // 移動先へタグ・カラーラベルを引き継ぐ
          deps.followPathChange?.(entry.path, dest);
        } else if (action.type === "addTag") {
          if (action.tag.trim()) deps.addTag(entry.path, action.tag.trim());
        } else if (action.type === "setLabel") {
          deps.setColorLabel([entry.path], action.color);
        }
        log.push({ ruleId: rule.id, path: entry.path, action, ok: true });
      } catch (e) {
        log.push({ ruleId: rule.id, path: entry.path, action, ok: false, error: String(e) });
      }
    }
    seen?.add(key);
  }

  return { matched, log };
}
