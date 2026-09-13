import { describe, it, expect } from "vitest";
import { collectTerminalIds, layoutReducer } from "./layoutStore";
import type { LayoutNode, PaneNode, Tab, Workspace } from "../types/layout";

const fileTab = (id: string): Tab => ({
  id,
  paneType: "file",
  title: id,
  path: `/${id}`,
  history: [],
  historyIndex: 0,
});

const terminalTab = (id: string): Tab => ({
  id,
  paneType: "terminal",
  title: id,
  cwd: "/home/u",
  terminalId: `pty-${id}`,
});

const pane = (id: string, tabs: Tab[]): PaneNode => ({
  type: "pane",
  id,
  tabs,
  activeTabId: tabs[0].id,
});

const split = (id: string, children: LayoutNode[]): LayoutNode => ({
  type: "split",
  id,
  direction: "vertical",
  sizes: children.map(() => 100 / children.length),
  children,
});

const workspace = (root: LayoutNode, extra?: LayoutNode): Workspace => ({
  version: 3,
  groups: extra
    ? [
        { id: "g1", label: "1", root },
        { id: "g2", label: "2", root: extra },
      ]
    : [{ id: "g1", label: "1", root }],
  activeGroupId: "g1",
});

describe("collectTerminalIds", () => {
  it("木の奥にあるターミナルも集める", () => {
    const ws = workspace(
      split("root", [
        pane("p1", [fileTab("f1"), terminalTab("t1")]),
        split("inner", [pane("p2", [terminalTab("t2")])]),
      ])
    );
    expect(collectTerminalIds(ws)).toEqual(new Set(["pty-t1", "pty-t2"]));
  });

  it("非アクティブなグループのターミナルも数に入れる", () => {
    // グループを跨いだとき、見えていないグループのシェルを落とさないため
    const ws = workspace(
      pane("p1", [terminalTab("t1")]),
      pane("p2", [terminalTab("t2")])
    );
    expect(collectTerminalIds(ws)).toEqual(new Set(["pty-t1", "pty-t2"]));
  });

  it("ターミナルが無ければ空", () => {
    expect(collectTerminalIds(workspace(pane("p1", [fileTab("f1")])))).toEqual(new Set());
  });
});

describe("ペインを閉じたときのターミナル", () => {
  it("閉じたペインのタブは残ったペインへ移るので、シェルは生き残る", () => {
    // 分割が 1 つになると split ノードは消えて木の形が変わる（React では
    // 残ったペインも作り直しになる）。それでもタブ自体は失われないことを固定する。
    const ws = workspace(
      split("root", [
        pane("p1", [fileTab("f1")]),
        pane("p2", [terminalTab("t1")]),
      ])
    );
    const next = layoutReducer(ws, { type: "CLOSE_PANE", paneId: "p1" });
    const root = next.groups[0].root;

    expect(root.type).toBe("pane");
    expect(collectTerminalIds(next)).toEqual(new Set(["pty-t1"]));
  });

  it("ターミナルのあるペインを閉じると、そのタブは隣のペインへ引き継がれる", () => {
    const ws = workspace(
      split("root", [
        pane("p1", [fileTab("f1")]),
        pane("p2", [terminalTab("t1")]),
      ])
    );
    const next = layoutReducer(ws, { type: "CLOSE_PANE", paneId: "p2" });
    // タブは消えない（= シェルも片付けられない）
    expect(collectTerminalIds(next)).toEqual(new Set(["pty-t1"]));
  });

  it("タブを閉じたときはレイアウトから消える（片付けの対象になる）", () => {
    const ws = workspace(pane("p1", [fileTab("f1"), terminalTab("t1")]));
    const next = layoutReducer(ws, { type: "CLOSE_TAB", paneId: "p1", tabId: "t1" });
    expect(collectTerminalIds(next)).toEqual(new Set());
  });
});
