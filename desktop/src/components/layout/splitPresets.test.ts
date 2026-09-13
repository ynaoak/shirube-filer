import { describe, it, expect } from "vitest";
import { LayoutNode, PaneNode, Tab } from "../../types/layout";
import {
  ASYMMETRIC_SPLITS,
  UNIFORM_SPLITS,
  buildSplitLayout,
  detectSplitPattern,
  isUniformPattern,
  patternPaneCount,
  patternShortLabel,
  patternsEqual,
} from "./splitPresets";

const tab = (id: string): Tab => ({
  id, paneType: "file", title: id, path: `/${id}`, history: [], historyIndex: 0,
});

const pane = (id: string): PaneNode => ({
  type: "pane", id, tabs: [tab(`${id}-t`)], activeTabId: `${id}-t`,
});

/** レイアウト順のペイン ID を集める（段構造の検証用）。 */
function paneIds(node: LayoutNode): string[] {
  return node.type === "pane" ? [node.id] : node.children.flatMap(paneIds);
}

describe("パターンのユーティリティ", () => {
  it("総ペイン数を段ごとのペイン数の合計として返す", () => {
    expect(patternPaneCount([2, 1])).toBe(3);
    expect(patternPaneCount([1])).toBe(1);
    expect(patternPaneCount([4, 4, 4, 4])).toBe(16);
  });

  it("均等かどうかを判定する", () => {
    expect(isUniformPattern([3, 3])).toBe(true);
    expect(isUniformPattern([1])).toBe(true);
    expect(isUniformPattern([2, 1])).toBe(false);
  });

  it("短いラベルは均等なら rows×cols、不均等なら段の連結", () => {
    expect(patternShortLabel([1])).toBe("1");
    expect(patternShortLabel([3])).toBe("1×3");
    expect(patternShortLabel([2, 2])).toBe("2×2");
    expect(patternShortLabel([2, 1])).toBe("2+1");
    expect(patternShortLabel([3, 3, 1])).toBe("3+3+1");
  });

  it("patternsEqual は長さと各段を比較する", () => {
    expect(patternsEqual([2, 1], [2, 1])).toBe(true);
    expect(patternsEqual([2, 1], [1, 2])).toBe(false);
    expect(patternsEqual([2], [2, 2])).toBe(false);
  });
});

describe("buildSplitLayout", () => {
  it("上 2・下 1 を vertical[horizontal[2], pane] として組み立てる", () => {
    const root = buildSplitLayout([2, 1]);
    expect(root.type).toBe("split");
    if (root.type !== "split") return;
    expect(root.direction).toBe("vertical");
    expect(root.sizes).toEqual([50, 50]);
    expect(root.children).toHaveLength(2);

    const [top, bottom] = root.children;
    expect(top.type).toBe("split");
    if (top.type === "split") {
      expect(top.direction).toBe("horizontal");
      expect(top.children).toHaveLength(2);
      expect(top.children.every((c) => c.type === "pane")).toBe(true);
    }
    // 1 ペインだけの段は horizontal 分割で包まず、ペインをそのまま置く
    expect(bottom.type).toBe("pane");
  });

  it("1 段だけのパターンは vertical 分割で包まない", () => {
    expect(buildSplitLayout([1]).type).toBe("pane");
    const row = buildSplitLayout([3]);
    expect(row.type).toBe("split");
    if (row.type === "split") expect(row.direction).toBe("horizontal");
  });

  it("既存ペインをレイアウト順に再利用する", () => {
    const existing = [pane("a"), pane("b"), pane("c")];
    const root = buildSplitLayout([2, 1], existing);
    expect(paneIds(root)).toEqual(["a", "b", "c"]);
  });

  it("収まりきらないペインのタブは最後のペインへ統合する", () => {
    const existing = [pane("a"), pane("b"), pane("c"), pane("d")];
    const root = buildSplitLayout([2, 1], existing);
    const panes = paneIds(root);
    expect(panes).toEqual(["a", "b", "c"]);

    const last = root.type === "split" ? root.children[1] : root;
    expect(last.type).toBe("pane");
    if (last.type !== "pane") return;
    expect(last.tabs.map((t) => t.id)).toEqual(["c-t", "d-t"]);
  });

  it("ペインが足りない分は新規に作る", () => {
    const root = buildSplitLayout([2, 1], [pane("a")]);
    const ids = paneIds(root);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe("a");
    expect(new Set(ids).size).toBe(3);
  });
});

describe("detectSplitPattern", () => {
  it("組み立てたレイアウトから元のパターンを復元する", () => {
    for (const pattern of [...UNIFORM_SPLITS, ...ASYMMETRIC_SPLITS]) {
      expect(detectSplitPattern(buildSplitLayout(pattern))).toEqual(pattern);
    }
  });

  it("単一ペインは [1]", () => {
    expect(detectSplitPattern(pane("a"))).toEqual([1]);
  });

  it("段に還元できない入れ子は null", () => {
    // 上段が「さらに縦分割されたペイン」を含むため、段構成として表せない
    const root: LayoutNode = {
      type: "split", id: "root", direction: "vertical", sizes: [50, 50],
      children: [
        {
          type: "split", id: "top", direction: "horizontal", sizes: [50, 50],
          children: [
            pane("a"),
            { type: "split", id: "nested", direction: "vertical", sizes: [50, 50], children: [pane("b"), pane("c")] },
          ],
        },
        pane("d"),
      ],
    };
    expect(detectSplitPattern(root)).toBeNull();
  });

  it("横一列の分割は 1 段として返す", () => {
    const root: LayoutNode = {
      type: "split", id: "root", direction: "horizontal", sizes: [50, 50],
      children: [pane("a"), pane("b")],
    };
    expect(detectSplitPattern(root)).toEqual([2]);
  });
});

describe("プリセット一覧", () => {
  it("プリセットが重複しない", () => {
    const keys = [...UNIFORM_SPLITS, ...ASYMMETRIC_SPLITS].map((p) => p.join("-"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("均等一覧は全て均等、不均等一覧は全て不均等", () => {
    expect(UNIFORM_SPLITS.every(isUniformPattern)).toBe(true);
    expect(ASYMMETRIC_SPLITS.some(isUniformPattern)).toBe(false);
  });

  it("上 2・下 1 が選べる", () => {
    expect(ASYMMETRIC_SPLITS.some((p) => patternsEqual(p, [2, 1]))).toBe(true);
  });
});
