import { createContext, useContext } from "react";
import { Workspace, WorkspaceGroup, Layout, LayoutNode, PaneNode, Tab } from "../types/layout";

export const GROUP_COLORS = [
  "#6366F1", // indigo
  "#8B5CF6", // violet
  "#A855F7", // purple
  "#EC4899", // pink
  "#F43F5E", // rose
  "#EF4444", // red
  "#F97316", // orange
  "#F59E0B", // amber
  "#EAB308", // yellow
  "#84CC16", // lime
  "#10B981", // emerald
  "#14B8A6", // teal
  "#06B6D4", // cyan
  "#3B82F6", // blue
  "#0EA5E9", // sky
  "#64748B", // slate
];

export type LayoutAction =
  // ── Pane / Tab actions (operate on active group's root) ──────────────────
  | { type: "SPLIT_PANE"; paneId: string; direction: "horizontal" | "vertical"; initialTab?: Tab; newPaneId?: string; sizes?: number[] }
  | { type: "CLOSE_PANE"; paneId: string }
  | { type: "ADD_TAB"; paneId: string; tab: Tab }
  | { type: "CLOSE_TAB"; paneId: string; tabId: string }
  | { type: "SET_ACTIVE_TAB"; paneId: string; tabId: string }
  | { type: "UPDATE_TAB"; paneId: string; tabId: string; patch: Record<string, unknown> }
  | { type: "MOVE_TAB"; tabId: string; sourcePaneId: string; targetPaneId: string }
  | { type: "REORDER_TAB"; paneId: string; tabId: string; targetTabId: string }
  | { type: "TOGGLE_PIN_TAB"; paneId: string; tabId: string }
  | { type: "UPDATE_SIZES"; nodeId: string; sizes: number[] }
  // ── Workspace group actions ───────────────────────────────────────────────
  | { type: "CREATE_GROUP"; label: string; color?: string }
  | { type: "DELETE_GROUP"; groupId: string }
  | { type: "RENAME_GROUP"; groupId: string; label: string }
  | { type: "SET_ACTIVE_GROUP"; groupId: string }
  | { type: "REORDER_GROUP"; groupId: string; targetGroupId: string }
  | { type: "SET_GROUP_COLOR"; groupId: string; color: string }
  | { type: "SET_LAYOUT"; layout: Layout }
  | { type: "SET_GROUP_ROOT"; root: LayoutNode };

export const genId = () => `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ── Helpers ───────────────────────────────────────────────────────────────

export function getActiveWorkspaceGroup(workspace: Workspace): WorkspaceGroup {
  return workspace.groups.find((g) => g.id === workspace.activeGroupId) ?? workspace.groups[0];
}

/**
 * ワークスペース内すべての（非アクティブなグループも含む）ターミナル ID を集める。
 *
 * タブが閉じられたターミナルの後始末に使う。グループを跨いでも生きているタブの
 * シェルを落とさないよう、アクティブなグループだけを見てはいけない。
 */
export function collectTerminalIds(workspace: Workspace): Set<string> {
  const ids = new Set<string>();
  const walk = (node: LayoutNode) => {
    if (node.type === "pane") {
      for (const tab of node.tabs) {
        if (tab.paneType === "terminal") ids.add(tab.terminalId);
      }
      return;
    }
    node.children.forEach(walk);
  };
  workspace.groups.forEach((group) => walk(group.root));
  return ids;
}

/** Count all tabs in a layout subtree. */
export function countAllTabs(node: LayoutNode): number {
  if (node.type === "pane") return node.tabs.length;
  return node.children.reduce((sum, c) => sum + countAllTabs(c), 0);
}

function makeDefaultPane(): PaneNode {
  const tabId = genId();
  return {
    type: "pane",
    id: genId(),
    tabs: [{ id: tabId, paneType: "file", title: "Home", path: "", history: [], historyIndex: 0 }],
    activeTabId: tabId,
  };
}

function makeDefaultGroup(label: string, color: string): WorkspaceGroup {
  return { id: genId(), label, color, root: makeDefaultPane() };
}

export function createDefaultLayout(): Workspace {
  const group = makeDefaultGroup("Group 1", GROUP_COLORS[0]);
  return { version: 3, groups: [group], activeGroupId: group.id };
}

// ── Migration ─────────────────────────────────────────────────────────────

/** Strip v2 tabGroups from a pane, keeping active group's tabs. */
function flattenPane(node: LayoutNode): LayoutNode {
  if (node.type === "split") {
    return { ...node, children: node.children.map(flattenPane) };
  }
  const raw = node as unknown as Record<string, unknown>;
  // v2: has tabGroups
  if (Array.isArray(raw["tabGroups"])) {
    type RawGroup = { id: string; tabs: Tab[]; activeTabId: string };
    const groups = raw["tabGroups"] as RawGroup[];
    const activeId = raw["activeGroupId"] as string | undefined;
    const active = groups.find((g) => g.id === activeId) ?? groups[0];
    if (!active) return node;
    return { type: "pane", id: node.id, tabs: active.tabs, activeTabId: active.activeTabId };
  }
  // v1: already has tabs
  return node;
}

/** Walk a LayoutNode tree and replace any duplicate node/tab IDs with fresh ones. */
function deduplicateNodes(node: LayoutNode, seen: Set<string>): LayoutNode {
  const id = seen.has(node.id) ? genId() : node.id;
  seen.add(id);
  if (node.type === "pane") {
    // Deduplicate tab IDs within this pane
    const tabSeen = new Set<string>();
    const idMap = new Map<string, string>(); // old → new
    const tabs = node.tabs.map((t) => {
      const newTabId = tabSeen.has(t.id) ? genId() : t.id;
      tabSeen.add(newTabId);
      if (newTabId !== t.id) idMap.set(t.id, newTabId);
      return { ...t, id: newTabId };
    });
    const activeTabId = idMap.get(node.activeTabId) ?? node.activeTabId;
    return { ...node, id, tabs, activeTabId };
  }
  return { ...node, id, children: node.children.map((c) => deduplicateNodes(c, seen)) };
}

/** Ensure all node and tab IDs across the entire workspace are unique. */
function deduplicateWorkspace(workspace: Workspace): Workspace {
  const seen = new Set<string>();
  const groups = workspace.groups.map((g) => {
    const groupId = seen.has(g.id) ? genId() : g.id;
    seen.add(groupId);
    return { ...g, id: groupId, root: deduplicateNodes(g.root, seen) };
  });
  return { ...workspace, groups };
}

export function migrateLayout(saved: unknown): Workspace {
  const raw = saved as Record<string, unknown>;
  let workspace: Workspace;
  // Already v3 Workspace
  if (Array.isArray(raw["groups"])) {
    workspace = saved as Workspace;
  } else if (raw["root"]) {
    // v1 / v2 Layout (has root)
    const flatRoot = flattenPane(raw["root"] as LayoutNode);
    const group = makeDefaultGroup("Group 1", GROUP_COLORS[0]);
    group.root = flatRoot;
    workspace = { version: 3, groups: [group], activeGroupId: group.id };
  } else {
    return createDefaultLayout();
  }
  return deduplicateWorkspace(workspace);
}

// ── Pane tree helpers ──────────────────────────────────────────────────────

function findAndUpdate(
  node: LayoutNode,
  paneId: string,
  updater: (pane: PaneNode) => LayoutNode | null
): LayoutNode | null {
  if (node.type === "pane") {
    if (node.id === paneId) return updater(node);
    return node;
  }
  let changed = false;
  const newChildren: LayoutNode[] = [];
  for (const child of node.children) {
    const result = findAndUpdate(child, paneId, updater);
    if (result === null) {
      changed = true;
    } else {
      if (result !== child) changed = true;
      newChildren.push(result);
    }
  }
  if (!changed) return node;
  if (newChildren.length === 1) return newChildren[0];
  if (newChildren.length === 0) return null;
  return { ...node, children: newChildren };
}

function findAndUpdateNode(
  node: LayoutNode,
  nodeId: string,
  updater: (n: LayoutNode) => LayoutNode
): LayoutNode {
  if (node.id === nodeId) return updater(node);
  if (node.type === "split") {
    return { ...node, children: node.children.map((c) => findAndUpdateNode(c, nodeId, updater)) };
  }
  return node;
}

/** Merge tabs into the leftmost pane of a subtree. */
function mergeTabsIntoFirstPane(node: LayoutNode, tabs: Tab[]): LayoutNode {
  if (tabs.length === 0) return node;
  if (node.type === "pane") {
    return { ...node, tabs: [...node.tabs, ...tabs] };
  }
  return { ...node, children: [mergeTabsIntoFirstPane(node.children[0], tabs), ...node.children.slice(1)] };
}

/**
 * Close a pane and merge its tabs into the adjacent sibling pane.
 * The left sibling is preferred; if none exists the right sibling is used.
 */
function closePaneAndMergeTabs(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "pane") {
    return node.id === paneId ? null : node;
  }

  // Check whether the direct target pane is a direct child of this split node
  const targetIdx = node.children.findIndex((c) => c.type === "pane" && c.id === paneId);
  if (targetIdx !== -1) {
    const targetPane = node.children[targetIdx] as PaneNode;
    const tabsToMerge = targetPane.tabs;
    const remaining = node.children.filter((_, i) => i !== targetIdx);
    if (remaining.length === 0) return null;
    // Merge into left sibling if available, otherwise the first remaining child
    const neighborIdx = targetIdx > 0 ? targetIdx - 1 : 0;
    const mergeIdx = Math.min(neighborIdx, remaining.length - 1);
    const merged = remaining.map((child, i) =>
      i === mergeIdx ? mergeTabsIntoFirstPane(child, tabsToMerge) : child
    );
    if (merged.length === 1) return merged[0];
    return { ...node, children: merged };
  }

  // Recurse into children
  let changed = false;
  const newChildren: LayoutNode[] = [];
  for (const child of node.children) {
    const result = closePaneAndMergeTabs(child, paneId);
    if (result === null) {
      changed = true;
    } else {
      if (result !== child) changed = true;
      newChildren.push(result);
    }
  }
  if (!changed) return node;
  if (newChildren.length === 1) return newChildren[0];
  if (newChildren.length === 0) return null;
  return { ...node, children: newChildren };
}

/** Apply a pane-tree action to a root LayoutNode. Returns new root or null if root was removed. */
function applyPaneAction(root: LayoutNode, action: LayoutAction): LayoutNode | null {
  switch (action.type) {
    case "SPLIT_PANE": {
      const newPaneNodeId = action.newPaneId ?? genId();
      const initialTab: Tab = action.initialTab ?? {
        id: genId(), paneType: "file", title: "Home", path: "", history: [], historyIndex: 0,
      };
      const newPane: PaneNode = {
        type: "pane", id: newPaneNodeId, tabs: [initialTab], activeTabId: initialTab.id,
      };
      return findAndUpdate(root, action.paneId, (pane) => ({
        type: "split", id: genId(), direction: action.direction, sizes: action.sizes ?? [50, 50],
        children: [pane, newPane],
      }));
    }

    case "CLOSE_PANE":
      return closePaneAndMergeTabs(root, action.paneId);

    case "ADD_TAB":
      return findAndUpdate(root, action.paneId, (pane) => ({
        ...pane, tabs: [...pane.tabs, action.tab], activeTabId: action.tab.id,
      }));

    case "CLOSE_TAB": {
      return findAndUpdate(root, action.paneId, (pane) => {
        const tabs = pane.tabs.filter((t) => t.id !== action.tabId);
        if (tabs.length === 0) return null;
        const activeTabId = pane.activeTabId === action.tabId ? tabs[tabs.length - 1].id : pane.activeTabId;
        return { ...pane, tabs, activeTabId };
      });
    }

    case "SET_ACTIVE_TAB":
      return findAndUpdate(root, action.paneId, (pane) => ({ ...pane, activeTabId: action.tabId }));

    case "UPDATE_TAB":
      return findAndUpdate(root, action.paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((t) => t.id === action.tabId ? ({ ...t, ...action.patch } as Tab) : t),
      }));

    case "MOVE_TAB": {
      const { tabId, sourcePaneId, targetPaneId } = action;
      if (sourcePaneId === targetPaneId) return root;
      let movedTab: Tab | null = null;
      const afterRemove = findAndUpdate(root, sourcePaneId, (pane) => {
        const tab = pane.tabs.find((t) => t.id === tabId);
        if (!tab) return pane;
        movedTab = tab;
        const tabs = pane.tabs.filter((t) => t.id !== tabId);
        if (tabs.length === 0) return null;
        const activeTabId = pane.activeTabId === tabId ? tabs[tabs.length - 1].id : pane.activeTabId;
        return { ...pane, tabs, activeTabId };
      });
      if (!movedTab || afterRemove === null) return root;
      return findAndUpdate(afterRemove, targetPaneId, (pane) => ({
        ...pane, tabs: [...pane.tabs, movedTab!], activeTabId: movedTab!.id,
      }));
    }

    case "REORDER_TAB": {
      const { paneId, tabId, targetTabId } = action;
      if (tabId === targetTabId) return root;
      return findAndUpdate(root, paneId, (pane) => {
        const tabs = [...pane.tabs];
        const fromIdx = tabs.findIndex((t) => t.id === tabId);
        const toIdx = tabs.findIndex((t) => t.id === targetTabId);
        if (fromIdx === -1 || toIdx === -1) return pane;
        const [moved] = tabs.splice(fromIdx, 1);
        tabs.splice(toIdx, 0, moved);
        return { ...pane, tabs };
      });
    }

    case "TOGGLE_PIN_TAB": {
      return findAndUpdate(root, action.paneId, (pane) => {
        const tab = pane.tabs.find((t) => t.id === action.tabId);
        if (!tab) return pane;
        const pinned = !tab.pinned;
        const updated = pane.tabs.map((t) => t.id === action.tabId ? { ...t, pinned } : t);
        const pinnedTabs = updated.filter((t) => t.pinned);
        const unpinnedTabs = updated.filter((t) => !t.pinned);
        return { ...pane, tabs: [...pinnedTabs, ...unpinnedTabs] };
      });
    }

    case "UPDATE_SIZES": {
      return findAndUpdateNode(root, action.nodeId, (node) => {
        if (node.type !== "split") return node;
        return { ...node, sizes: action.sizes };
      });
    }

    default:
      return root;
  }
}

// ── Top-level workspace reducer ───────────────────────────────────────────

export function layoutReducer(workspace: Workspace, action: LayoutAction): Workspace {
  switch (action.type) {
    // ── Group actions ───────────────────────────────────────────────────────
    case "CREATE_GROUP": {
      const color = action.color ?? GROUP_COLORS[workspace.groups.length % GROUP_COLORS.length];
      const group = makeDefaultGroup(action.label, color);
      return { ...workspace, groups: [...workspace.groups, group], activeGroupId: group.id };
    }

    case "DELETE_GROUP": {
      const remaining = workspace.groups.filter((g) => g.id !== action.groupId);
      if (remaining.length === 0) return createDefaultLayout();
      const activeGroupId =
        workspace.activeGroupId === action.groupId
          ? remaining[remaining.length - 1].id
          : workspace.activeGroupId;
      return { ...workspace, groups: remaining, activeGroupId };
    }

    case "RENAME_GROUP":
      return {
        ...workspace,
        groups: workspace.groups.map((g) =>
          g.id === action.groupId ? { ...g, label: action.label } : g
        ),
      };

    case "SET_ACTIVE_GROUP":
      return { ...workspace, activeGroupId: action.groupId };

    case "REORDER_GROUP": {
      const { groupId, targetGroupId } = action;
      if (groupId === targetGroupId) return workspace;
      const groups = [...workspace.groups];
      const fromIdx = groups.findIndex((g) => g.id === groupId);
      const toIdx = groups.findIndex((g) => g.id === targetGroupId);
      if (fromIdx === -1 || toIdx === -1) return workspace;
      const [moved] = groups.splice(fromIdx, 1);
      groups.splice(toIdx, 0, moved);
      return { ...workspace, groups };
    }

    case "SET_GROUP_COLOR":
      return {
        ...workspace,
        groups: workspace.groups.map((g) =>
          g.id === action.groupId ? { ...g, color: action.color } : g
        ),
      };

    case "SET_LAYOUT":
      return migrateLayout(action.layout);

    case "SET_GROUP_ROOT":
      return {
        ...workspace,
        groups: workspace.groups.map((g) =>
          g.id === workspace.activeGroupId ? { ...g, root: action.root } : g
        ),
      };

    // ── Pane / Tab actions (apply to active group's root) ───────────────────
    default: {
      const activeGroup = getActiveWorkspaceGroup(workspace);
      if (!activeGroup) return workspace;
      const newRoot = applyPaneAction(activeGroup.root, action);
      // If root was removed entirely, rebuild active group with a fresh pane
      const resolvedRoot = newRoot ?? makeDefaultPane();
      if (resolvedRoot === activeGroup.root) return workspace;
      return {
        ...workspace,
        groups: workspace.groups.map((g) =>
          g.id === activeGroup.id ? { ...g, root: resolvedRoot } : g
        ),
      };
    }
  }
}

// ── Context ───────────────────────────────────────────────────────────────

export type LayoutContextValue = {
  layout: Workspace;
  dispatch: React.Dispatch<LayoutAction>;
  activePaneId: string | null;
  setActivePaneId: (id: string | null) => void;
  setActiveTreePath: (path: string) => void;
  previewPaneId: string | null;
  setPreviewPaneId: (id: string | null) => void;
  previewFilePath: string | null;
};

export const LayoutContext = createContext<LayoutContextValue | null>(null);

export function useLayout() {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("useLayout must be used within LayoutRoot");
  return ctx;
}
