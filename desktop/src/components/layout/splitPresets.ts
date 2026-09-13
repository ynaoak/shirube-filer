import { LayoutNode, PaneNode } from "../../types/layout";
import { genId } from "../../store/layoutStore";

/**
 * ペイン分割の形を「段ごとのペイン数」で表したもの。
 * 例: [2, 1] = 上段 2 ペイン / 下段 1 ペイン、[3, 3] = 2×3 の均等格子。
 * 均等格子は同じ値の繰り返しなので、この 1 つの型で均等・不均等の両方を扱える。
 */
export type SplitPattern = number[];

/** 均等格子（rows×cols）のプリセット。 */
export const UNIFORM_SPLITS: SplitPattern[] = [
  [1],
  [2],
  [3],
  [2, 2],
  [3, 3],
  [4, 4],
  [3, 3, 3],
  [5, 5],
  [4, 4, 4],
  [4, 4, 4, 4],
];

/**
 * 段ごとにペイン数が異なるプリセット。上下を入れ替えた対を並べてあるので、
 * 「上に多い / 下に多い」のどちらでも同じ手数で選べる。
 */
export const ASYMMETRIC_SPLITS: SplitPattern[] = [
  [2, 1],
  [1, 2],
  [3, 1],
  [1, 3],
  [2, 3],
  [3, 2],
  [2, 2, 1],
  [1, 2, 2],
  [3, 3, 1],
  [1, 3, 3],
];

/** パターンの総ペイン数。 */
export const patternPaneCount = (pattern: SplitPattern): number =>
  pattern.reduce((sum, cols) => sum + cols, 0);

/** 全段が同じペイン数（＝均等格子）か。 */
export const isUniformPattern = (pattern: SplitPattern): boolean =>
  pattern.every((cols) => cols === pattern[0]);

export const patternsEqual = (a: SplitPattern, b: SplitPattern): boolean =>
  a.length === b.length && a.every((cols, i) => cols === b[i]);

/** ボタン下に出す短いラベル。均等なら "2×3"、不均等なら "2+1"。 */
export function patternShortLabel(pattern: SplitPattern): string {
  if (pattern.length === 1 && pattern[0] === 1) return "1";
  if (isUniformPattern(pattern)) return `${pattern.length}×${pattern[0]}`;
  return pattern.join("+");
}

function makeEmptyPane(): PaneNode {
  const tabId = genId();
  return {
    type: "pane",
    id: genId(),
    tabs: [{ id: tabId, paneType: "file", title: "Home", path: "", history: [], historyIndex: 0 }],
    activeTabId: tabId,
  };
}

/**
 * パターンどおりのレイアウトツリーを組み立てる。
 * 既存ペインはレイアウト順にそのまま再利用し、減段で収まりきらないペインの
 * タブは破棄せず、最後に残るペインへ統合して引き継ぐ。
 */
export function buildSplitLayout(pattern: SplitPattern, existingPanes: PaneNode[] = []): LayoutNode {
  const total = patternPaneCount(pattern);
  const reused = existingPanes.slice(0, total);
  if (existingPanes.length > total && reused.length > 0) {
    const overflowTabs = existingPanes.slice(total).flatMap((p) => p.tabs);
    const last = reused[reused.length - 1];
    reused[reused.length - 1] = { ...last, tabs: [...last.tabs, ...overflowTabs] };
  }
  let paneIndex = 0;
  const makePane = (): PaneNode => reused[paneIndex++] ?? makeEmptyPane();
  const makeRow = (cols: number): LayoutNode => {
    if (cols === 1) return makePane();
    return {
      type: "split",
      id: genId(),
      direction: "horizontal",
      sizes: Array(cols).fill(100 / cols),
      children: Array.from({ length: cols }, makePane),
    };
  };
  if (pattern.length === 1) return makeRow(pattern[0]);
  return {
    type: "split",
    id: genId(),
    direction: "vertical",
    sizes: pattern.map(() => 100 / pattern.length),
    children: pattern.map((cols) => makeRow(cols)),
  };
}

/** 1 段（ペイン、または全子がペインの horizontal 分割）のペイン数。段として扱えなければ null。 */
function rowPaneCount(row: LayoutNode): number | null {
  if (row.type === "pane") return 1;
  if (row.direction === "horizontal" && row.children.every((c) => c.type === "pane")) {
    return row.children.length;
  }
  return null;
}

/**
 * 現在のレイアウトが段構成として表せるならパターンを返す
 * （ポップオーバーの現在値ハイライト＆ツールバーアイコン用）。
 * 手動分割などで段に還元できない形になっている場合は null。
 */
export function detectSplitPattern(node: LayoutNode): SplitPattern | null {
  if (node.type === "pane") return [1];
  if (node.direction === "horizontal") {
    return node.children.every((c) => c.type === "pane") ? [node.children.length] : null;
  }
  const pattern: SplitPattern = [];
  for (const row of node.children) {
    const cols = rowPaneCount(row);
    if (cols === null) return null;
    pattern.push(cols);
  }
  return pattern;
}
