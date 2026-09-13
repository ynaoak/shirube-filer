import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../common/Icon";
import { APP_EVENTS } from "../../lib/appEvents";
import { ReadDirResult } from "../../types/fs";

type VolumeInfo = { path: string; label: string; kind: string };

type TreeNode = {
  path: string;
  name: string;
  children: TreeNode[] | null; // null = not loaded, [] = loaded but empty
  isOpen: boolean;
};

type Props = {
  currentPath: string;
  onNavigate: (path: string) => void;
  onClose: () => void;
  /** When true, hides the header and resize handle — width is controlled by parent. */
  controlled?: boolean;
};

/** Split a path into its segments (handles both / and \). */
function splitPath(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean);
}

/** Build the ancestor path at depth d from root segments. */
function ancestorPath(segments: string[], depth: number, sep: string): string {
  if (depth === 0) return sep === "\\" ? segments[0] + "\\" : "/" + segments[0];
  // Windows: C:\foo\bar  Unix: /foo/bar
  if (sep === "\\") return segments[0] + "\\" + segments.slice(1, depth + 1).join("\\");
  return "/" + segments.slice(0, depth + 1).join("/");
}

async function loadChildren(path: string): Promise<TreeNode[]> {
  try {
    const result = await invoke<ReadDirResult>("read_dir", { path });
    return result.entries
      .filter((e) => e.isDir && !e.isHidden)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((e) => ({ path: e.path, name: e.name, children: null, isOpen: false }));
  } catch {
    return [];
  }
}

export default function FileTreePanel({ currentPath, onNavigate, onClose, controlled = false }: Props) {
  const { t } = useTranslation();
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const syncGenRef = useRef(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Detect path separator
  const sep = currentPath.includes("\\") ? "\\" : "/";

  /** Expand nodes along the currentPath, loading lazily as needed. */
  const syncToPath = useCallback(async (path: string, nodes: TreeNode[]): Promise<TreeNode[]> => {
    if (!path || nodes.length === 0) return nodes;
    const segs = splitPath(path);
    if (segs.length === 0) return nodes;

    const rootPath = sep === "\\" ? segs[0] + "\\" : "/";

    async function openNode(nodeList: TreeNode[], targetPath: string, depth: number): Promise<TreeNode[]> {
      return Promise.all(
        nodeList.map(async (node) => {
          if (node.path !== targetPath && !targetPath.startsWith(node.path)) return node;
          let children = await loadChildren(node.path);
          if (depth < segs.length) {
            const nextTarget = ancestorPath(segs, depth, sep);
            children = await openNode(children, nextTarget, depth + 1);
          }
          return { ...node, children, isOpen: true };
        })
      );
    }

    return openNode(nodes, rootPath, 1);
  }, [sep]);

  // マウント時にドライブ一覧を取得し、currentPath があれば直ちに展開する
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const syncToPathRef = useRef(syncToPath);
  syncToPathRef.current = syncToPath;

  useEffect(() => {
    let cancelled = false;
    // list_volumes は1回だけ実行。syncGenRef は currentPath エフェクト専用のため
    // ここでは使わず、cancelled フラグのみで制御する。
    invoke<VolumeInfo[]>("list_volumes").then(async (vols) => {
      if (cancelled) return;
      const driveNodes: TreeNode[] = vols.map((vol) => ({
        path: vol.path,
        name: vol.label ? `${vol.label} (${vol.path.replace(/\\$/, "")})` : vol.path,
        children: null,
        isOpen: false,
      }));
      const path = currentPathRef.current;
      const expanded = path ? await syncToPathRef.current(path, driveNodes) : driveNodes;
      if (!cancelled) setRoots(expanded);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for FS-change events from FileList and refresh the tree accordingly.
  useEffect(() => {
    if (!currentPath) return;
    const pathSep = currentPath.includes("\\") ? "\\" : "/";
    const handler = (e: Event) => {
      const changed = (e as CustomEvent<{ path: string }>).detail.path;
      const changedWithSep = changed.endsWith(pathSep) ? changed : changed + pathSep;
      if (currentPath === changed || currentPath.startsWith(changedWithSep)) {
        setRefreshTick((t) => t + 1);
      }
    };
    window.addEventListener(APP_EVENTS.FS_DIR_CHANGED, handler);
    return () => window.removeEventListener(APP_EVENTS.FS_DIR_CHANGED, handler);
  }, [currentPath]);

  // currentPath が変化したら対象ドライブ配下を展開する（ドライブ読み込み後）
  useEffect(() => {
    if (!currentPath) return;
    const gen = ++syncGenRef.current;
    setRoots((prev) => {
      if (prev.length === 0) return prev; // まだドライブ未読み込み
      syncToPath(currentPath, prev).then((next) => {
        if (gen === syncGenRef.current) setRoots(next);
      });
      return prev;
    });
  }, [currentPath, syncToPath, refreshTick]);

  // Scroll the exact active node into view after tree updates
  useLayoutEffect(() => {
    if (!scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector<HTMLElement>('[data-tree-exact="true"]');
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [roots, currentPath]);

  const handleToggle = useCallback(async (path: string) => {
    setRoots((prev) => {
      const updateNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (node) => {
            if (node.path === path) {
              const nowOpen = !node.isOpen;
              let children = node.children;
              if (nowOpen && children === null) {
                children = await loadChildren(node.path);
              }
              return { ...node, isOpen: nowOpen, children };
            }
            if (node.children) {
              return { ...node, children: await updateNode(node.children) };
            }
            return node;
          })
        );
      };
      updateNode(prev).then(setRoots);
      return prev;
    });
  }, []);

  const handleRefreshNode = useCallback((path: string) => {
    setRoots((prev) => {
      const reload = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (node) => {
            if (node.path === path) {
              const children = await loadChildren(node.path);
              return { ...node, children, isOpen: true };
            }
            if (node.children) {
              return { ...node, children: await reload(node.children) };
            }
            return node;
          })
        );
      };
      reload(prev).then(setRoots);
      return prev;
    });
  }, []);

  return (
    <div
      className={controlled ? "flex flex-col flex-1 overflow-hidden" : "flex flex-col shrink-0 border-r overflow-hidden"}
      style={controlled ? {
        backgroundColor: "var(--kf-bg-secondary)",
      } : {
        width: 220,
        backgroundColor: "var(--kf-bg-secondary)",
        borderColor: "var(--kf-border)",
      }}
    >
      {/* Header — hidden in controlled mode (parent provides its own header) */}
      {!controlled && (
        <div
          className="flex items-center justify-between px-3 py-1.5 border-b shrink-0"
          style={{ borderColor: "var(--kf-border)" }}
        >
          <span className="text-xs font-semibold" style={{ color: "var(--kf-text-secondary)" }}>
            {t("fileTreePanel.title")}
          </span>
          <button
            onClick={onClose}
            className="opacity-50 hover:opacity-100 flex items-center"
            title={t("fileTreePanel.close")}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      {/* Tree */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto">
        {roots.map((node) => (
          <TreeNodeView
            key={node.path}
            node={node}
            depth={0}
            currentPath={currentPath}
            onToggle={handleToggle}
            onNavigate={onNavigate}
            onRefreshNode={handleRefreshNode}
            sep={sep}
          />
        ))}
      </div>
    </div>
  );
}

function TreeNodeView({
  node,
  depth,
  currentPath,
  onToggle,
  onNavigate,
  onRefreshNode,
  sep,
}: {
  node: TreeNode;
  depth: number;
  currentPath: string;
  onToggle: (path: string) => void;
  onNavigate: (path: string) => void;
  onRefreshNode: (path: string) => void;
  sep: string;
}) {
  const isActive = currentPath === node.path ||
    currentPath.startsWith(node.path.endsWith(sep) ? node.path : node.path + sep);
  const isExact = currentPath === node.path;

  return (
    <div>
      <div
        data-tree-exact={isExact ? "true" : undefined}
        className="flex items-center gap-1 cursor-pointer select-none py-0.5 px-1 text-xs group"
        style={{
          paddingLeft: 8 + depth * 14,
          // 選択行はアクセントを黒側へ寄せた濃い塗り（--kf-sel-bg）にして、
          // 白い文字とフォルダアイコンが沈まないようにする。アクセントを
          // そのまま敷くと淡いテーマでコントラストが 1.7:1 まで落ちていた。
          backgroundColor: isExact ? "var(--kf-sel-bg)" : isActive ? "var(--kf-bg-tertiary)" : undefined,
          color: isExact ? "var(--kf-sel-fg)" : "var(--kf-text-primary)",
        }}
        onClick={() => {
          onRefreshNode(node.path);
          if (!isExact) onNavigate(node.path);
        }}
      >
        <button
          className="flex items-center shrink-0 opacity-50 hover:opacity-100"
          style={{ width: 14 }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.path);
          }}
        >
          {node.isOpen ? (
            <Icon name="expand_more" size={13} style={{ color: isExact ? "var(--kf-sel-fg)" : undefined }} />
          ) : (
            <Icon name="chevron_right" size={13} style={{ color: isExact ? "var(--kf-sel-fg)" : undefined }} />
          )}
        </button>
        <Icon
          name={depth === 0 ? "hard_drive" : node.isOpen ? "folder_open" : "folder"}
          size={13}
          style={{ color: isExact ? "var(--kf-sel-fg)" : "var(--kf-accent)" }}
        />
        <span className="truncate ml-0.5" title={node.name}>{node.name}</span>
      </div>

      {node.isOpen && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              onToggle={onToggle}
              onNavigate={onNavigate}
              onRefreshNode={onRefreshNode}
              sep={sep}
            />
          ))}
        </div>
      )}
    </div>
  );
}
