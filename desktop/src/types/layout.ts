export type SplitDirection = "horizontal" | "vertical";

export type FileTab = {
  id: string;
  paneType: "file";
  title: string;
  path: string;
  history: string[];
  historyIndex: number;
  pinned?: boolean;
};

export type TerminalTab = {
  id: string;
  paneType: "terminal";
  title: string;
  cwd: string;
  terminalId: string;
  pinned?: boolean;
};

export type TrashTab = {
  id: string;
  paneType: "trash";
  title: string;
  pinned?: boolean;
};

export type Tab = FileTab | TerminalTab | TrashTab;

export type PaneNode = {
  type: "pane";
  id: string;
  tabs: Tab[];
  activeTabId: string;
};

export type SplitNode = {
  type: "split";
  id: string;
  direction: SplitDirection;
  sizes: number[];
  children: LayoutNode[];
};

export type LayoutNode = PaneNode | SplitNode;

export type WorkspaceGroup = {
  id: string;
  label: string;
  color?: string;
  root: LayoutNode;
};

export type Workspace = {
  version: number;
  groups: WorkspaceGroup[];
  activeGroupId: string;
};

// Backward-compat alias
export type Layout = Workspace;
