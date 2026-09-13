import { useReducer, useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  LayoutContext,
  LayoutAction,
  createDefaultLayout,
  layoutReducer,
  migrateLayout,
  getActiveWorkspaceGroup,
  countAllTabs,
  collectTerminalIds,
  GROUP_COLORS,
  genId,
} from "../../store/layoutStore";
import { Workspace, LayoutNode, PaneNode, Tab } from "../../types/layout";
import { APP_EVENTS } from "../../lib/appEvents";
import { disposeRemovedTerminals } from "../../lib/terminalRegistry";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  TAB_IMPORT_EVENT,
  TAB_DRAG_OVER_EVENT,
  TAB_DRAG_LEAVE_EVENT,
  CLOUD_FILE_DROP_EVENT,
  TabImportPayload,
  TabDragOverPayload,
  CloudFileDropPayload,
  isTearoffWindow,
  isChildWindow,
} from "../../lib/tearoff";
import LayoutRenderer from "./LayoutRenderer";
import {
  SplitPattern,
  UNIFORM_SPLITS,
  ASYMMETRIC_SPLITS,
  buildSplitLayout,
  detectSplitPattern,
  isUniformPattern,
  patternPaneCount,
  patternShortLabel,
  patternsEqual,
} from "./splitPresets";
import ActivityBar, { LeftPanelTab } from "./ActivityBar";
import AddonProvider from "../providers/AddonProvider";
import AddonPanel from "../panels/AddonPanel";
import GitPanel from "../panels/GitPanel";
import TaskRunnerPanel from "../panels/TaskRunnerPanel";
import KeybindingProvider from "../providers/KeybindingProvider";
import PreviewPanel from "../panels/PreviewPanel";
import ProgressOverlay from "../common/ProgressOverlay";
import StatusBar from "./StatusBar";
import CommandPalette, { PaletteCommand } from "../dialogs/CommandPalette";
import GrepPanel from "../panels/GrepPanel";
import IndexSearchPanel from "../panels/IndexSearchPanel";
import TagSearchPanel from "../panels/TagSearchPanel";
import RuleManagerPanel from "../panels/RuleManagerPanel";
import CloudSyncPanel from "../cloudSync/CloudSyncPanel";
import LeftSidePanel from "./LeftSidePanel";
import DuplicatePanel from "../panels/DuplicatePanel";
import ErrorBoundary from "../providers/ErrorBoundary";
import { createDragGhost, DragGhost } from "../../lib/dragGhost";
import { useMenuClamp } from "../../hooks/useMenuClamp";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { useWindowControls, WinCaptionButtons } from "./WindowTitleBar";
import appIcon from "../../assets/app-icon.png";
import { openUrl } from "@tauri-apps/plugin-opener";
import ToastHost from "../common/ToastHost";
import { useKeybindings, matchBinding } from "../../store/keybindingStore";
import { useAddons } from "../../store/addonStore";
import { useUiSettings } from "../../store/uiSettingsStore";
import { useFollowPathChange, useForgetPathMetadata } from "../../hooks/useFollowPathChange";
import { useColorLabels } from "../../store/colorLabelStore";
import { StatusContext, StatusInfo, defaultStatus } from "../../store/statusStore";
import { CompareContext, buildDiffStatus } from "../../store/compareStore";
import { FileEntry } from "../../types/fs";
import { UndoContext, FileOp } from "../../store/undoStore";
import { OperationQueueContext, QueueItem, QueueOp } from "../../store/operationQueueStore";
import { useRules } from "../../store/ruleStore";
import { useTags } from "../../store/tagStore";
import { executeRule } from "../../lib/ruleExecutor";
import { useSyncJobs } from "../../store/syncStore";
import { downloadEntry, type RemoteEntry } from "../../lib/cloudSyncEngine";
import { showToast } from "../../lib/toast";
import { isTrashUnavailable, stripTrashMarker } from "../../lib/trashError";
import i18n from "../../i18n";

/** macOS の純正 traffic light（閉じる/最小化/フルスクリーン）が占める左上の幅。
 *  ヘッダーの中身はこの分だけ右にずらす。 */
const MAC_TRAFFIC_LIGHT_INSET = 78;

/** macOS のヘッダー高さ。純正タイトルバー（28pt）に重なるボタンが
 *  縦中央に来るよう、Windows/Linux の 38px より一段高くする。 */
const MAC_HEADER_MIN_HEIGHT = 44;

// ── Split preset helpers ──────────────────────────────────────────────────

/** ツリーを左上から深さ優先でたどり、最初に見つかったペインを返す */
function findFirstPane(node: LayoutNode): PaneNode | null {
  if (node.type === "pane") return node;
  for (const child of node.children) {
    const found = findFirstPane(child);
    if (found) return found;
  }
  return null;
}

/** ツリーを左上から深さ優先でたどり、全ペインをレイアウト順で返す */
function collectPanes(node: LayoutNode): PaneNode[] {
  if (node.type === "pane") return [node];
  return node.children.flatMap(collectPanes);
}

/** 段ごとにペイン数が異なってもよい分割プレビュー。 */
function SplitIcon({ pattern }: { pattern: SplitPattern }) {
  const W = 22, H = 15, gap = 1.2, pad = 1;
  const rows = pattern.length;
  const cellH = (H - pad * 2 - gap * (rows - 1)) / rows;
  return (
    <svg width={W} height={H} style={{ display: "block", flexShrink: 0 }}>
      {pattern.flatMap((cols, r) => {
        const cellW = (W - pad * 2 - gap * (cols - 1)) / cols;
        return Array.from({ length: cols }, (_, c) => (
          // 塗り潰しだと 1×1（＝分割なし）のときに大きな単色の板になり、
          // タイトルバー右端で異物のように見えてしまう。枠線＋薄い塗りにして
          // どの分割数でも「ペインの枠」として読めるようにする。
          <rect
            key={`${r}-${c}`}
            x={pad + c * (cellW + gap) + 0.5}
            y={pad + r * (cellH + gap) + 0.5}
            width={Math.max(cellW - 1, 0.5)}
            height={Math.max(cellH - 1, 0.5)}
            fill="currentColor"
            fillOpacity={0.22}
            stroke="currentColor"
            strokeWidth={1}
            rx={1}
          />
        ));
      })}
    </svg>
  );
}

// ── DFS: collect all active file-tab paths in layout order ───────────────
/** DFS: collect all active file-tab paths in layout order. */
function findAllActiveFilePaths(node: LayoutNode): string[] {
  if (node.type === "pane") {
    const tab = node.tabs.find((t) => t.id === node.activeTabId);
    return tab?.paneType === "file" && tab.path ? [tab.path] : [];
  }
  return node.children.flatMap(findAllActiveFilePaths);
}

/** DFS: first active file-tab path found in the layout tree. */
function findActiveFilePath(node: LayoutNode): string {
  if (node.type === "pane") {
    const tab = node.tabs.find((t) => t.id === node.activeTabId);
    return tab?.paneType === "file" ? tab.path : "";
  }
  for (const child of node.children) {
    const p = findActiveFilePath(child);
    if (p) return p;
  }
  return "";
}

function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const p = findPane(child, paneId);
    if (p) return p;
  }
  return null;
}

function findActivePane(node: LayoutNode): PaneNode | null {
  if (node.type === "pane") return node;
  for (const child of node.children) {
    const p = findActivePane(child);
    if (p) return p;
  }
  return null;
}

function LayoutRootInner() {
  const { t } = useTranslation();
  // ウィンドウ操作（最小化/最大化/閉じる）。グループバーをタイトルバーに兼用する。
  const { isMac, maximized, minimize, toggleMax, close } = useWindowControls();
  const [layout, dispatch] = useReducer(layoutReducer, undefined, createDefaultLayout);
  // group bar UI state
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; groupId: string; editName?: boolean } | null>(null);
  // ペイン分割プリセットのポップオーバー開閉（タイトルバーの 1 ボタンに集約）
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const colorInputRef = useRef<HTMLInputElement>(null);
  // グループ名の編集値（変更ポップアップ内の入力欄で使用）。
  // 外側クリック/フォーカス移動で閉じるときにも確定できるよう ref でも参照する。
  const [renameValue, setRenameValue] = useState("");
  const renameValueRef = useRef("");
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const { ref: groupMenuRef, pos: groupMenuPos } = useMenuClamp(groupMenu?.x ?? 0, groupMenu?.y ?? 0);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [activeTreePath, setActiveTreePath] = useState<string>("");
  const [previewPaneId, _setPreviewPaneId] = useState<string | null>(null);
  const previewPaneIdRef = useRef<string | null>(null);
  const setPreviewPaneId = useCallback((id: string | null) => {
    previewPaneIdRef.current = id;
    _setPreviewPaneId(id);
  }, []);
  const [statusInfo, setStatusInfo] = useState<StatusInfo>(defaultStatus);
  const setStatus = useCallback((patch: Partial<StatusInfo>) => {
    setStatusInfo((prev) => {
      // Shallow-equal short-circuit: avoid re-rendering StatusBar subscribers
      // when the same numbers/strings are re-sent on every selection/filter tick.
      let changed = false;
      for (const k in patch) {
        if ((prev as Record<string, unknown>)[k] !== (patch as Record<string, unknown>)[k]) {
          changed = true;
          break;
        }
      }
      return changed ? { ...prev, ...patch } : prev;
    });
  }, []);

  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportError = useCallback((msg: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setStatusInfo((prev) => ({ ...prev, error: msg }));
    errorTimerRef.current = setTimeout(() => {
      setStatusInfo((prev) => ({ ...prev, error: null }));
    }, 4000);
  }, []);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [showTaskPanel, setShowTaskPanel] = useState(false);
  // タスクパネルはシェル（PTY）を抱えるので、閉じてもアンマウントしない。
  // 一度開いたら非表示で残し、実行中の開発サーバーが閉じる操作で落ちないようにする。
  const [taskPanelMounted, setTaskPanelMounted] = useState(false);
  const [showPreviewPanel, setShowPreviewPanel] = useState(false);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [openAddonId, setOpenAddonId] = useState<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showGrepPanel, setShowGrepPanel] = useState(false);
  const [showIndexPanel, setShowIndexPanel] = useState(false);
  const [showTagPanel, setShowTagPanel] = useState(false);
  const [showRulePanel, setShowRulePanel] = useState(false);
  const [showSyncPanel, setShowSyncPanel] = useState(false);

  // ── 自動化ルールの auto-run ────────────────────────────────────────
  // fs:changed イベント（watch_dir が emit）を受けたとき、autoRun=true の
  // ルールで watchPath が変更されたディレクトリと一致するものを実行する。
  // セッション単位の seen キャッシュで同一ファイルの二重処理を防ぐ。
  const { rules: autoRules } = useRules();
  const { addTag: autoAddTag } = useTags();
  const { setColorLabel: autoSetColorLabel } = useColorLabels();
  const ruleSeenRef = useRef(new Set<string>());
  useEffect(() => {
    const unlisten = listen<{ path: string }>("fs:changed", async (event) => {
      const changedDir = event.payload.path;
      // NOTE: 以前ここは localStorage の "kf-color-labels" を直接書いていたが、
      // それは colorLabelStore が起動時に読み込んで削除する移行用の旧キーで、
      // ルールで付けたラベルが保存されない状態だった。ストア経由に統一する。
      const deps = {
        addTag: autoAddTag,
        setColorLabel: autoSetColorLabel,
        followPathChange: followPathChangeRef.current,
      };
      for (const rule of autoRules) {
        if (!rule.enabled || !rule.autoRun) continue;
        if (rule.watchPath !== changedDir) continue;
        await executeRule(rule, deps, { seen: ruleSeenRef.current }).catch(() => {});
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  // autoRules が変わったら listener を張り直す（ルール編集の反映）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRules, autoAddTag, autoSetColorLabel]);
  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [leftPanelTab, setLeftPanelTab] = useState<LeftPanelTab>(() => {
    const saved = localStorage.getItem("kf-left-panel-tab");
    if (saved === "home" || saved === "bookmark") return saved;
    return "tree";
  });
  const [undoStack, setUndoStack] = useState<FileOp[]>([]);
  const [redoStack, setRedoStack] = useState<FileOp[]>([]);

  const pushOp = useCallback((op: FileOp) => {
    setUndoStack((prev) => [...prev.slice(-49), op]);
    setRedoStack([]); // new action clears redo history
  }, []);

  const undoOp = useCallback((): FileOp | null => {
    let last: FileOp | null = null;
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      last = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    if (last) setRedoStack((prev) => [...prev.slice(-49), last!]);
    return last;
  }, []);

  const redoOp = useCallback((): FileOp | null => {
    let last: FileOp | null = null;
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      last = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    if (last) setUndoStack((prev) => [...prev.slice(-49), last!]);
    return last;
  }, []);

  // 元に戻す / やり直しでもパスが動くので、タグ・カラーラベルを追従させる。
  const followPathChange = useFollowPathChange();
  const followPathChangeRef = useRef(followPathChange);
  useEffect(() => { followPathChangeRef.current = followPathChange; }, [followPathChange]);
  // 削除したファイルのタグ・カラーラベルは残さず捨てる
  const forgetPathMetadata = useForgetPathMetadata();
  const forgetPathMetadataRef = useRef(forgetPathMetadata);
  useEffect(() => { forgetPathMetadataRef.current = forgetPathMetadata; }, [forgetPathMetadata]);

  // React の外（クラウド同期など）からの削除通知を受けて同じ後始末をする。
  useEffect(() => {
    const handler = (e: Event) => {
      const { paths } = ((e as CustomEvent).detail ?? {}) as { paths?: string[] };
      if (paths?.length) forgetPathMetadataRef.current(paths);
    };
    window.addEventListener(APP_EVENTS.PATHS_DELETED, handler);
    return () => window.removeEventListener(APP_EVENTS.PATHS_DELETED, handler);
  }, []);

  const performUndo = useCallback(async (op: FileOp) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (op.type === "rename") {
        await invoke("rename_item", { path: op.newPath, newName: op.oldPath.split(/[\\/]/).pop() });
        followPathChange(op.newPath, op.oldPath);
      } else if (op.type === "move") {
        await Promise.all(op.srcPaths.map((src) => {
          const name = src.split(/[\\/]/).pop()!;
          const from = `${op.destDir}/${name}`;
          const to = `${op.originalDir}/${name}`;
          return invoke("move_item", { src: from, dest: to }).then(() => followPathChange(from, to));
        }));
      } else if (op.type === "copy") {
        await Promise.all(op.srcPaths.map((src) => {
          const name = src.split(/[\\/]/).pop()!;
          const copied = `${op.destDir}/${name}`;
          return invoke("delete_item", { path: copied }).then(() => forgetPathMetadata([copied]));
        }));
      }
      // delete cannot be undone (no trash restore API)
    } catch (e) {
      console.error("[undo]", e);
      reportError(t("layoutRoot.undoFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [reportError, followPathChange, forgetPathMetadata]);

  const performRedo = useCallback(async (op: FileOp) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (op.type === "rename") {
        await invoke("rename_item", { path: op.oldPath, newName: op.newPath.split(/[\\/]/).pop() });
        followPathChange(op.oldPath, op.newPath);
      } else if (op.type === "move") {
        await Promise.all(op.srcPaths.map((src) => {
          const name = src.split(/[\\/]/).pop()!;
          const from = `${op.originalDir}/${name}`;
          const to = `${op.destDir}/${name}`;
          return invoke("move_item", { src: from, dest: to }).then(() => followPathChange(from, to));
        }));
      } else if (op.type === "copy") {
        await Promise.all(op.srcPaths.map((src) => {
          const name = src.split(/[\\/]/).pop()!;
          return invoke("copy_item", { src, dest: `${op.destDir}/${name}` });
        }));
      }
    } catch (e) {
      console.error("[redo]", e);
      reportError(t("layoutRoot.redoFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [reportError, followPathChange]);

  // ─── Operation Queue ────────────────────────────────────────────────────────
  const [queueItems, _setQueueItems] = useState<QueueItem[]>([]);
  const queueItemsRef = useRef<QueueItem[]>([]);
  const setQueueItems = useCallback((fn: (prev: QueueItem[]) => QueueItem[]) => {
    const next = fn(queueItemsRef.current);
    queueItemsRef.current = next;
    _setQueueItems(next);
  }, []);
  const [queuePaused, _setQueuePaused] = useState(false);
  const queuePausedRef = useRef(false);
  const setQueuePaused = useCallback((p: boolean) => {
    queuePausedRef.current = p;
    _setQueuePaused(p);
  }, []);
  const isQueueProcessingRef = useRef(false);
  const processQueue = useCallback(async () => {
    if (isQueueProcessingRef.current) return;
    isQueueProcessingRef.current = true;
    // ゴミ箱に入らなかったときの「完全に削除しますか？」の回答は操作グループ単位で
    // 使い回す（まとめて選んだ 50 件で 50 回聞かれるのを避ける）。
    const permanentFallbackChoice = new Map<string, boolean>();
    try {
      while (!queuePausedRef.current) {
        const pending = queueItemsRef.current.find((i) => i.status === "pending");
        if (!pending) break;
        const id = pending.id;
        setQueueItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: "running" } : i)));

        // 時間のかかる操作の進捗を購読する。
        // MTP からの取り出しはコピーと同じ copy-progress を流す（USB 越しで
        // 時間がかかるうえ、進捗が無いと止まっているのか判断できないため）。
        // 移動はボリューム跨ぎのときだけ内部でコピーになり、そのときだけ
        // move-progress が流れる（同一ボリュームの rename は一瞬なので無し）。
        const progressEvent =
          pending.op.type === "copy" || pending.op.type === "mtpDownload"
            ? "copy-progress"
            : pending.op.type === "move"
              ? "move-progress"
              : null;
        let unlisten: (() => void) | null = null;
        if (progressEvent) {
          unlisten = await listen<{
            current: number; total: number; file: string; done: boolean; bytesDone: number; bytesTotal: number;
          }>(progressEvent, (ev) => {
            if (ev.payload.done) return;
            setQueueItems((prev) =>
              prev.map((i) =>
                i.id === id
                  ? { ...i, progress: { current: ev.payload.current, total: ev.payload.total, file: ev.payload.file, bytesDone: ev.payload.bytesDone, bytesTotal: ev.payload.bytesTotal } }
                  : i
              )
            );
          });
        }

        try {
          if (pending.op.type === "copy") {
            await invoke("copy_item", { src: pending.op.src, dest: pending.op.dest, overwrite: pending.op.overwrite });
          } else if (pending.op.type === "move") {
            await invoke("move_item", { src: pending.op.src, dest: pending.op.dest, overwrite: pending.op.overwrite });
            // 移動が成功したら、タグ・カラーラベルの紐づけ先も移す。
            // D&D・貼り付け・自動化ルールの移動はすべてこのキューを通る。
            followPathChangeRef.current(pending.op.src, pending.op.dest);
          } else if (pending.op.type === "delete") {
            await invoke("delete_item", { path: pending.op.path, trash: pending.op.trash });
            forgetPathMetadataRef.current([pending.op.path]);
          } else if (pending.op.type === "mtpDownload") {
            // MTP は通常のファイルシステムではないため copy_item ではなく
            // WPD 経由の取り出しコマンドを使う（src は mtp:// の仮想パス）。
            await invoke("mtp_download", { path: pending.op.src, dest: pending.op.dest, overwrite: pending.op.overwrite });
          }
          // Only mark done if not already cancelled
          const current = queueItemsRef.current.find((i) => i.id === id);
          if (current && current.status !== "cancelled") {
            setQueueItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: "done", progress: undefined } : i)));
          }
        } catch (e) {
          const rawError = String(e);
          // 目印は判定にだけ使い、表示するメッセージからは取り除く。
          let errStr = stripTrashMarker(rawError);
          const current = queueItemsRef.current.find((i) => i.id === id);
          if (current && current.status !== "cancelled") {
            // ゴミ箱に入れられない項目（ゴミ箱が無効・容量超過など）は、その場で
            // 完全削除に切り替えるかを確認する。黙って完全削除はしない。
            if (pending.op.type === "delete" && pending.op.trash && isTrashUnavailable(rawError)) {
              let deletePermanently = permanentFallbackChoice.get(pending.groupLabel);
              if (deletePermanently === undefined) {
                deletePermanently = window.confirm(
                  i18n.t("operationQueue.trashUnavailableConfirm", { label: pending.label, reason: errStr })
                );
                permanentFallbackChoice.set(pending.groupLabel, deletePermanently);
              }
              if (deletePermanently) {
                try {
                  await invoke("delete_item", { path: pending.op.path, trash: false });
                  forgetPathMetadataRef.current([pending.op.path]);
                  setQueueItems((prev) =>
                    prev.map((i) => (i.id === id ? { ...i, status: "done", progress: undefined } : i))
                  );
                  continue;
                } catch (permanentError) {
                  // 完全削除も失敗したときは、そちらの理由を表示する。
                  errStr = String(permanentError);
                }
              } else {
                setQueueItems((prev) =>
                  prev.map((i) => (i.id === id ? { ...i, status: "cancelled", progress: undefined } : i))
                );
                continue;
              }
            }
            const wasCancelled = errStr.includes("キャンセル");
            setQueueItems((prev) =>
              prev.map((i) =>
                i.id === id
                  ? { ...i, status: wasCancelled ? "cancelled" : "error", error: wasCancelled ? undefined : errStr, progress: undefined }
                  : i
              )
            );
            // 失敗はキューを開かないと気付けないため、即時トーストで通知する
            // （詳細は操作キューのエラー行で確認できる）
            if (!wasCancelled) {
              showToast(i18n.t("operationQueue.opFailedToast", { label: pending.label }));
            }
          }
        } finally {
          if (unlisten) unlisten();
        }
      }
    } finally {
      isQueueProcessingRef.current = false;
    }
  }, [setQueueItems]);

  // Start processing whenever new pending items appear or queue is unpaused
  useEffect(() => {
    if (!queuePaused && queueItems.some((i) => i.status === "pending")) {
      processQueue();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueItems, queuePaused]);

  const enqueueOps = useCallback(
    (ops: Array<{ op: QueueOp; label: string }>, groupLabel: string) => {
      const newItems: QueueItem[] = ops.map(({ op, label }) => ({
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        op,
        label,
        groupLabel,
        status: "pending",
        addedAt: Date.now(),
      }));
      setQueueItems((prev) => [...prev, ...newItems]);
    },
    [setQueueItems]
  );

  const cancelQueueItem = useCallback(
    (id: string) => {
      const item = queueItemsRef.current.find((i) => i.id === id);
      if (!item) return;
      if (item.status === "pending") {
        setQueueItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: "cancelled" } : i)));
      } else if (item.status === "running") {
        setQueueItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: "cancelled", progress: undefined } : i)));
        invoke("cancel_operation").catch(() => {});
      }
    },
    [setQueueItems]
  );

  const retryQueueItem = useCallback(
    (id: string) => {
      setQueueItems((prev) =>
        prev.map((i) =>
          i.id === id && (i.status === "error" || i.status === "cancelled")
            ? { ...i, status: "pending", error: undefined }
            : i
        )
      );
    },
    [setQueueItems]
  );

  const clearCompletedQueue = useCallback(() => {
    setQueueItems((prev) => prev.filter((i) => i.status !== "done" && i.status !== "cancelled"));
  }, [setQueueItems]);
  // ────────────────────────────────────────────────────────────────────────────

  const [showFolderCompare, setShowFolderCompare] = useState(false);

  const [showDuplicatePanel, setShowDuplicatePanel] = useState(false);

  // ─── Compare window state sync ──────────────────────────────────────────────
  useEffect(() => {
    const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kf-compare-window") : null;
    if (!bc) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "compare-opened") setShowFolderCompare(true);
      else if (e.data?.type === "compare-closed") setShowFolderCompare(false);
    };
    bc.addEventListener("message", handler);
    return () => { bc.removeEventListener("message", handler); bc.close(); };
  }, []);

  // セーフティネット: 比較ウィンドウが OS の閉じるボタンで破棄され close 通知を
  // 取りこぼしても、メインウィンドウがフォーカスを得た時点でウィンドウの実在を確認し、
  // 無ければアクティブ表示（アクティビティバーの青線）を確実に消す。
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win
      .onFocusChanged(async ({ payload: focused }) => {
        if (!focused) return;
        try {
          const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
          const wins = await getAllWebviewWindows();
          if (!wins.some((w) => w.label === "folder-compare")) {
            setShowFolderCompare(false);
          }
        } catch { /* ignore */ }
      })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);
  // ────────────────────────────────────────────────────────────────────────────

  // ─── Queue BroadcastChannel ─────────────────────────────────────────────────
  const queueBcRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kf-queue") : null;
    queueBcRef.current = bc;
    if (!bc) return;
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "cmd") {
        const { action, id } = msg as { action: string; id?: string };
        if (action === "cancel" && id) cancelQueueItem(id);
        else if (action === "retry" && id) retryQueueItem(id);
        else if (action === "clear") clearCompletedQueue();
        else if (action === "pause") setQueuePaused(true);
        else if (action === "resume") setQueuePaused(false);
      } else if (msg.type === "request-state") {
        bc.postMessage({ type: "state", items: queueItemsRef.current, paused: queuePausedRef.current });
      }
    };
    bc.addEventListener("message", handler);
    return () => {
      bc.removeEventListener("message", handler);
      bc.close();
      queueBcRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    queueBcRef.current?.postMessage({ type: "state", items: queueItems, paused: queuePaused });
  }, [queueItems, queuePaused]);
  // ────────────────────────────────────────────────────────────────────────────


  const openSettingsWindow = useCallback(async (tab?: string) => {
    const { WebviewWindow, getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const windows = await getAllWebviewWindows();
    const existing = windows.find((w) => w.label === "settings");
    if (existing) {
      await existing.setFocus();
      return;
    }
    const tabParam = tab ? `&tab=${tab}` : "";
    new WebviewWindow("settings", {
      url: `${window.location.origin}/?mode=settings${tabParam}`,
      title: t("settings.title"),
      width: 820,
      height: 640,
      resizable: true,
      center: true,
    });
  }, []);

  const openQueueWindow = useCallback(async () => {
    const { WebviewWindow, getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const windows = await getAllWebviewWindows();
    const existing = windows.find((w) => w.label === "queue");
    if (existing) {
      await existing.setFocus();
      return;
    }
    new WebviewWindow("queue", {
      url: `${window.location.origin}/?mode=queue`,
      title: t("toolbar.queue"),
      width: 640,
      height: 520,
      resizable: true,
      center: true,
    });
  }, [t]);

  const openFolderCompareWindow = useCallback(async () => {
    const { WebviewWindow, getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const windows = await getAllWebviewWindows();
    const existing = windows.find((w) => w.label === "folder-compare");
    if (existing) {
      await existing.setFocus();
      return;
    }
    const palRoot = getActiveWorkspaceGroup(layout)?.root;
    const paths = palRoot ? findAllActiveFilePaths(palRoot) : [];
    const left = paths[0] ?? "";
    const right = paths[1] ?? paths[0] ?? "";
    const params = new URLSearchParams({ mode: "folder-compare" });
    if (left) params.set("left", left);
    if (right) params.set("right", right);
    new WebviewWindow("folder-compare", {
      url: `${window.location.origin}/?${params.toString()}`,
      title: t("toolbar.folderCompare"),
      width: 900,
      height: 680,
      resizable: true,
      center: true,
    });
  }, [t, layout]);

  const [paneEntriesMap, setPaneEntriesMap] = useState<Map<string, FileEntry[]>>(new Map());

  const handleOpenFeedback = useCallback(() => {
    // フィードバックは GitHub の Issue 作成ページへ案内する
    openUrl("https://github.com/ynaoak/shirube-filer/issues/new").catch(console.error);
  }, []);

  const registerEntries = useCallback((paneId: string, entries: FileEntry[]) => {
    setPaneEntriesMap((prev) => {
      const next = new Map(prev);
      next.set(paneId, entries);
      return next;
    });
  }, []);

  const getDiffStatus = useCallback((paneId: string, entry: FileEntry) => {
    if (!showFolderCompare) return null;
    // Find another pane's entries to compare against
    const otherEntries = Array.from(paneEntriesMap.entries()).find(([id]) => id !== paneId)?.[1];
    if (!otherEntries) return null;
    const otherMap = new Map(otherEntries.map((e) => [e.name.toLowerCase(), e]));
    return buildDiffStatus(entry, otherMap);
  }, [showFolderCompare, paneEntriesMap]);
  const { bindings } = useKeybindings();
  // クラウドブラウザウィンドウからのドロップ（CLOUD_FILE_DROP_EVENT）で参照するため、
  // 最新の jobs を ref で保持する（イベントリスナーのクロージャが古い配列を掴むのを防ぐ）。
  const { jobs: syncJobs } = useSyncJobs();
  const jobsSyncRef = useRef(syncJobs);
  useEffect(() => { jobsSyncRef.current = syncJobs; }, [syncJobs]);
  const { loaded } = useAddons();
  const [{ autoShowPreview, autoShowTaskPanel }] = useUiSettings();

  // 閉じられたターミナルタブの実体（xterm と PTY）を片付ける。
  //
  // ターミナルは React の外（terminalRegistry）に置いてあり、ペインの組み替えで
  // コンポーネントが作り直されてもプロセスが生き残るようにしている。その代わり、
  // 「タブが本当に無くなった」ことはレイアウトを見て判断する必要がある。
  // これまでレイアウトにあった id だけを対象にするので、レイアウトに属さない
  // シェル（タスクパネルのもの）には手を出さない。
  const knownTerminalIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const alive = collectTerminalIds(layout);
    disposeRemovedTerminals(knownTerminalIdsRef.current, alive);
    knownTerminalIdsRef.current = alive;
  }, [layout]);

  const toggleTaskPanel = useCallback(() => {
    setTaskPanelMounted(true);
    setShowTaskPanel((v) => !v);
  }, []);

  // package.json / Cargo.toml / Makefile にフォーカスが当たったらタスクパネルを開く。
  // 閉じるのは手動に任せる（フォーカスが外れるたびに消えると、一覧から
  // タスクを選ぶ操作の途中でパネルが引っ込んでしまう）。
  useEffect(() => {
    if (!autoShowTaskPanel) return;
    const handler = () => { setTaskPanelMounted(true); setShowTaskPanel(true); };
    window.addEventListener(APP_EVENTS.MANIFEST_FOCUSED, handler);
    return () => window.removeEventListener(APP_EVENTS.MANIFEST_FOCUSED, handler);
  }, [autoShowTaskPanel]);

  // 分割レイアウト時にプレビューペインが閉じられたことを検知してクリア
  useEffect(() => {
    if (!previewPaneId) return;
    const root = getActiveWorkspaceGroup(layout)?.root;
    if (!root) return;
    if (!findPane(root, previewPaneId)) {
      setPreviewPaneId(null);
    }
  }, [layout, previewPaneId, setPreviewPaneId]);

  // ファイル選択時: 分割ペインがあればそこにプレビューを表示、なければフローティングパネル
  const handleSelectFile = useCallback((path: string | null) => {
    setPreviewFilePath(path);
    if (previewPaneIdRef.current) {
      // 既存のプレビューペインにファイルパスを反映するだけ
      return;
    }
    const root = getActiveRoot();
    const hasSplit = root ? root.type === "split" : false;
    // 自動プレビューが無効なら、クリックは選択のみ（分割時のペイン生成も行わない）。
    if (!autoShowPreview) return;
    if (hasSplit && path) {
      const currentPaneId = activePaneIdRef.current ?? (root ? findActivePane(root)?.id : null);
      if (currentPaneId) {
        const newId = genId();
        previewPaneIdRef.current = newId;
        _setPreviewPaneId(newId);
        dispatch({ type: "SPLIT_PANE", paneId: currentPaneId, direction: "vertical", newPaneId: newId, sizes: [60, 40] });
      }
    } else if (path && autoShowPreview) {
      setShowPreviewPanel(true);
    }
  }, [autoShowPreview, dispatch]);

  // グループ名を確定（空欄は無視）。ポップアップの Enter / 閉じる操作から呼ぶ。
  const commitGroupMenuRename = (groupId: string) => {
    const v = renameValueRef.current.trim();
    if (v) dispatch({ type: "RENAME_GROUP", groupId, label: v });
  };

  // group menu close on outside click / outside focus / Escape
  // 外側クリック・外側フォーカスは「編集中の名前を確定して」閉じ、
  // Escape はキャンセル（名前を確定しない）。
  // ウィンドウ blur では閉じない: カスタムカラーのネイティブピッカーを
  // 開くとウィンドウがフォーカスを失うため、そこで閉じると色を選べなくなる。
  useDismissOnOutside(
    !!groupMenu,
    groupMenuRef,
    () => {
      if (groupMenu) commitGroupMenuRename(groupMenu.groupId);
      setGroupMenu(null);
    },
    () => setGroupMenu(null)
  );

  // ペイン分割ポップオーバー（タイトルバーの 1 ボタンに集約）:
  // 外側クリック / 外側へのフォーカス移動 / Escape で閉じる
  const splitMenuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(splitMenuOpen, splitMenuRef, () => setSplitMenuOpen(false));

  renameValueRef.current = renameValue;

  // ポップアップを「名前編集」モードで開いたら入力欄へフォーカス
  useEffect(() => {
    if (groupMenu?.editName && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [groupMenu]);

  // 切り離し（子）ウィンドウかどうか。子ウィンドウは共有レイアウトファイルを
  // 読み書きせず、切り離されたタブ 1 枚を種にして起動する。
  const isTearoff = useMemo(() => isTearoffWindow(), []);
  const isChild = useMemo(() => isChildWindow(), []);

  // Session persistence: restore layout on mount
  useEffect(() => {
    if (isTearoff) {
      // 切り離しウィンドウ: stash からタブを取り出し、1 グループ 1 ペーンで起動する。
      const label = getCurrentWindow().label;
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke<string | null>("take_tearoff", { label })
          .then((json) => {
            if (!json) return;
            const tab = JSON.parse(json) as Tab;
            const groupId = genId();
            const group = {
              id: groupId,
              label: "Group 1",
              color: GROUP_COLORS[0],
              root: {
                type: "pane" as const,
                id: genId(),
                tabs: [tab],
                activeTabId: tab.id,
              },
            };
            dispatch({
              type: "SET_LAYOUT",
              layout: { version: 3, groups: [group], activeGroupId: groupId },
            });
          })
          .catch(() => {})
      );
      return;
    }
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<string>("load_layout", { format: "json" })
        .then((content) => {
          const saved = JSON.parse(content);
          dispatch({ type: "SET_LAYOUT", layout: migrateLayout(saved) });
        })
        .catch(() => {}) // no saved layout yet — use default
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session persistence: auto-save layout on every change (debounced 600ms)。
  // 子ウィンドウは一時的な存在なので共有レイアウトファイルへは保存しない。
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isChild) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("save_layout", { content: JSON.stringify(layout), format: "json" }).catch(() => {})
      );
    }, 600);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [layout, isChild]);

  // Refs for stable callbacks that always read the latest values
  const activePaneIdRef = useRef(activePaneId);
  const layoutRef = useRef<Workspace>(layout);
  useEffect(() => { activePaneIdRef.current = activePaneId; }, [activePaneId]);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  const getActiveRoot = () => getActiveWorkspaceGroup(layoutRef.current)?.root ?? null;

  // ウィンドウ間タブ D&D: 別ウィンドウから送られてきたタブを受け取り、
  // カーソル位置のペーン（無ければアクティブ／先頭ペーン）へ統合する。
  //
  // 注意: グローバル listen()（EventTarget::Any）は emitTo() で「他ウィンドウ宛て」に
  // 送られたイベントも受信してしまう（Any は emit フィルタより優先でマッチする）。
  // その場合、送信元ウィンドウが自分の送ったタブを再取り込みして複製が生まれるため、
  // 必ず現在ウィンドウにスコープしたリスナーで受ける。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().listen<TabImportPayload>(TAB_IMPORT_EVENT, async (e) => {
      const { tab, cursorX, cursorY } = e.payload;
      const win = getCurrentWindow();
      win.setFocus().catch(() => {});

      // カーソル物理座標 → このウィンドウのクライアント座標へ変換し、落とし先ペーンを探す。
      let targetPaneId: string | null = null;
      try {
        const inner = await win.innerPosition();
        const sf = await win.scaleFactor();
        const cx = (cursorX - inner.x) / sf;
        const cy = (cursorY - inner.y) / sf;
        const els = document.elementsFromPoint(cx, cy);
        const paneEl = els.find((el) => el.hasAttribute("data-pane-id"));
        if (paneEl) targetPaneId = paneEl.getAttribute("data-pane-id");
      } catch { /* 位置が取れなければアクティブペーンにフォールバック */ }

      const root = getActiveRoot();
      const paneId =
        targetPaneId ??
        activePaneIdRef.current ??
        (root ? findActivePane(root)?.id : null) ??
        (root ? findFirstPane(root)?.id : null) ??
        null;
      if (!paneId) return;

      // 別ウィンドウ由来の id 衝突を避けるため id を振り直す。
      // ターミナルは PTY をウィンドウ間で引き継げないので terminalId も振り直す
      // （据え置くと、移動元の後始末が移動先で開いたシェルを落としてしまう）。
      const imported = (
        tab.paneType === "terminal"
          ? { ...tab, id: genId(), terminalId: genId() }
          : { ...tab, id: genId() }
      ) as Tab;
      dispatch({ type: "ADD_TAB", paneId, tab: imported });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // クラウドブラウザウィンドウの行がドロップされた（＝ダウンロード依頼）。
  // カーソル位置のペーンが表示中のディレクトリへ、リモートの 1 ファイルを保存する。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().listen<CloudFileDropPayload>(CLOUD_FILE_DROP_EVENT, async (e) => {
      const { jobId, entry, cursorX, cursorY } = e.payload;
      const win = getCurrentWindow();
      win.setFocus().catch(() => {});

      // カーソル物理座標 → クライアント座標へ変換し、落とし先ペーンの表示中パスを探す。
      let destDir = "";
      try {
        const inner = await win.innerPosition();
        const sf = await win.scaleFactor();
        const cx = (cursorX - inner.x) / sf;
        const cy = (cursorY - inner.y) / sf;
        const els = document.elementsFromPoint(cx, cy);
        const paneEl = els.find((el) => el.hasAttribute("data-pane-id"));
        const targetPaneId = paneEl?.getAttribute("data-pane-id") ?? null;
        if (targetPaneId) {
          for (const group of layoutRef.current.groups) {
            const pane = findPaneById(group.root, targetPaneId);
            if (pane) {
              const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
              if (tab?.paneType === "file" && tab.path) destDir = tab.path;
              break;
            }
          }
        }
      } catch { /* フォールバックへ */ }

      // フォールバック: アクティブペインの現在のファイルパス。
      if (!destDir) {
        const root = getActiveRoot();
        const activePane = activePaneIdRef.current && root ? findPane(root, activePaneIdRef.current) : null;
        const tab = activePane?.tabs.find((t) => t.id === activePane.activeTabId);
        if (tab?.paneType === "file" && tab.path) destDir = tab.path;
      }

      if (!destDir) {
        showToast(t("cloudBrowser.dropNoTarget"));
        return;
      }

      const job = jobsSyncRef.current.find((j) => j.id === jobId);
      if (!job) return;
      if (entry.isDir) {
        showToast(t("cloudBrowser.dropDirUnsupported"));
        return;
      }

      try {
        // downloadEntry は relPath / lastModified を参照しないため、既定値で補って渡す。
        const remoteEntry: RemoteEntry = { ...entry, relPath: entry.name, lastModified: null };
        await downloadEntry(job, remoteEntry, destDir);
        showToast(t("cloudBrowser.droppedDownload", { name: entry.name }));
      } catch (err) {
        showToast(String(err));
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ウィンドウ間タブ D&D: 別ウィンドウがこの窓の上をドラッグ中に送ってくる
  // over/leave を受けて、こちら側にもゴーストを表示する（マウスは移動元が
  // キャプチャしていて、この窓の DOM にはポインタイベントが届かない）。
  useEffect(() => {
    let cancelled = false;
    let unlistenOver: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;
    let ghost: DragGhost | null = null;
    let expireTimer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;

    const clearGhost = () => {
      ghost?.destroy();
      ghost = null;
      if (expireTimer) clearTimeout(expireTimer);
      expireTimer = undefined;
    };

    const win = getCurrentWindow();
    win
      .listen<TabDragOverPayload>(TAB_DRAG_OVER_EVENT, async (e) => {
        const mySeq = ++seq;
        try {
          const inner = await win.innerPosition();
          const sf = await win.scaleFactor();
          if (cancelled || mySeq !== seq) return; // 古い座標で動かさない
          const cx = (e.payload.cursorX - inner.x) / sf;
          const cy = (e.payload.cursorY - inner.y) / sf;
          if (!ghost) ghost = createDragGhost(e.payload.title);
          ghost.move(cx, cy);
          // leave を取り逃しても残留しないよう、無通知が続いたら自動で消す
          if (expireTimer) clearTimeout(expireTimer);
          expireTimer = setTimeout(clearGhost, 600);
        } catch { /* ignore */ }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenOver = fn;
      })
      .catch(() => {});
    win
      .listen(TAB_DRAG_LEAVE_EVENT, () => {
        seq++;
        clearGhost();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenLeave = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      clearGhost();
      unlistenOver?.();
      unlistenLeave?.();
    };
  }, []);

  // Native window menu event listener
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("menu-event", (e) => {
      const id = e.payload;
      const activeRoot = getActiveRoot();
      const currentPaneId = activePaneIdRef.current ?? (activeRoot ? findActivePane(activeRoot)?.id : null) ?? null;
      switch (id) {
        case "new-tab":
          if (currentPaneId) {
            dispatch({
              type: "ADD_TAB",
              paneId: currentPaneId,
              tab: { id: genId(), paneType: "file", title: "Home", path: "", history: [], historyIndex: 0 },
            });
          }
          break;
        case "close-tab": {
          if (currentPaneId && activeRoot) {
            const pane = findPaneById(activeRoot, currentPaneId);
            if (pane) {
              dispatch({ type: "CLOSE_TAB", paneId: currentPaneId, tabId: pane.activeTabId });
            }
          }
          break;
        }
        case "toggle-file-tree":    setShowLeftPanel((v) => !v); break;
        case "toggle-bookmark": {
          if (showLeftPanel && leftPanelTab === "bookmark") { setShowLeftPanel(false); }
          else { setLeftPanelTab("bookmark"); localStorage.setItem("kf-left-panel-tab", "bookmark"); setShowLeftPanel(true); }
          break;
        }
        case "toggle-preview":      setShowPreviewPanel((v) => !v); break;
        case "toggle-git":          setShowGitPanel((v) => !v); break;
        case "toggle-tasks":        toggleTaskPanel(); break;
        case "toggle-grep":         setShowGrepPanel((v) => !v); break;
        case "toggle-index":        setShowIndexPanel((v) => !v); break;
        case "toggle-tags":         setShowTagPanel((v) => !v); break;
        case "toggle-rules":        setShowRulePanel((v) => !v); break;
        case "toggle-sync":         setShowSyncPanel((v) => !v); break;
        case "toggle-queue":        openQueueWindow(); break;
        case "toggle-compare":
        case "open-folder-compare": openFolderCompareWindow(); break;
        case "open-duplicates":     setShowDuplicatePanel(true); break;
        case "command-palette":     setShowCommandPalette(true); break;
        case "open-addon-manager":  openSettingsWindow("addon"); break;
        case "open-settings":       openSettingsWindow(); break;
        case "open-feedback":       handleOpenFeedback(); break;
        case "open-trash": {
          const trashPaneId = activePaneIdRef.current ?? (activeRoot ? findActivePane(activeRoot)?.id : null) ?? null;
          if (trashPaneId) {
            dispatch({ type: "ADD_TAB", paneId: trashPaneId, tab: { id: genId(), paneType: "trash", title: "Trash" } });
          }
          break;
        }
        default: {
          if (id.startsWith("open-drive:")) {
            const drivePath = id.slice("open-drive:".length);
            const drivePaneId = activePaneIdRef.current ?? (activeRoot ? findActivePane(activeRoot)?.id : null) ?? null;
            if (drivePaneId) {
              dispatch({
                type: "ADD_TAB",
                paneId: drivePaneId,
                tab: { id: genId(), paneType: "file", title: drivePath, path: drivePath, history: [drivePath], historyIndex: 0 },
              });
            }
          }
          break;
        }
      }
    }).then((u) => {
      if (cancelled) u(); // アンマウント済みなら即解除
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [dispatch, handleOpenFeedback]);

  const activeGroup = getActiveWorkspaceGroup(layout);
  const activeRoot = activeGroup?.root;

  // ── ペイン分割プリセット ──────────────────────────────────────────────
  // 現在の分割形。手動分割などで段構成に還元できない形のときは null。
  const currentSplitPattern = activeRoot ? detectSplitPattern(activeRoot) : null;

  const applySplitPreset = (pattern: SplitPattern) => {
    const panes = activeRoot ? collectPanes(activeRoot) : [];
    const newRoot = buildSplitLayout(pattern, panes);
    dispatch({ type: "SET_GROUP_ROOT", root: newRoot });
    // アクティブペインが減段で消えた場合は、そのタブの
    // 統合先（残った最後のペイン）へフォーカスを移す
    const kept = collectPanes(newRoot);
    if (activePaneId && !kept.some((p) => p.id === activePaneId)) {
      setActivePaneId(kept[kept.length - 1]?.id ?? null);
    }
    setSplitMenuOpen(false);
  };

  const splitPresetTitle = (pattern: SplitPattern) => {
    const count = patternPaneCount(pattern);
    if (count === 1) return t("layoutRoot.noSplit");
    if (isUniformPattern(pattern)) {
      return t("layoutRoot.splitLayout", { count, rows: pattern.length, cols: pattern[0] });
    }
    return t("layoutRoot.splitLayoutRows", { count, pattern: pattern.join("+") });
  };

  const renderSplitPreset = (pattern: SplitPattern) => {
    const isCurrent = currentSplitPattern !== null && patternsEqual(currentSplitPattern, pattern);
    return (
      <button
        key={pattern.join("-")}
        onClick={() => applySplitPreset(pattern)}
        title={splitPresetTitle(pattern)}
        className="flex flex-col items-center gap-0.5 rounded px-1 py-1.5 transition-colors"
        style={{
          color: isCurrent ? "var(--kf-accent)" : "var(--kf-text-secondary)",
          backgroundColor: isCurrent ? "color-mix(in srgb, var(--kf-accent) 18%, transparent)" : "transparent",
          border: "1px solid " + (isCurrent ? "var(--kf-accent)" : "var(--kf-border-soft)"),
        }}
        onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.backgroundColor = "var(--kf-bg-tertiary)"; }}
        onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.backgroundColor = "transparent"; }}
      >
        <SplitIcon pattern={pattern} />
        <span style={{ fontSize: 9, lineHeight: 1 }}>{patternShortLabel(pattern)}</span>
      </button>
    );
  };

  const activePath = useMemo(() => {
    // Prefer path set directly from navigation (most reliable)
    if (activeTreePath) return activeTreePath;
    if (!activeRoot) return "";
    // Fall back: use the focused pane's path, or DFS-first pane if none focused
    const focusedPane = activePaneId ? findPane(activeRoot, activePaneId) : null;
    if (focusedPane) {
      const tab = focusedPane.tabs.find((t) => t.id === focusedPane.activeTabId);
      if (tab?.paneType === "file" && tab.path) return tab.path;
    }
    return findActiveFilePath(activeRoot);
  }, [activeTreePath, activeRoot, activePaneId]);

  // アクティブフォルダ名を OS のウィンドウタイトル（タスクバー）とカスタム
  // タイトルバーに反映する。ネイティブのファイラ（Explorer / Finder）と同様、
  // ヘッダーには製品名ではなく現在地（フォルダ名）を表示する。
  useEffect(() => {
    const folder = activePath
      ? (activePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || activePath)
      : "";
    document.title = folder ? `${folder} — Shirube-Filer` : "Shirube-Filer";
    // ヘッダーには現在地のフルパスを表示する（OS タイトルは簡潔にフォルダ名）。
    window.dispatchEvent(new CustomEvent(APP_EVENTS.ACTIVE_PATH, { detail: activePath }));
  }, [activePath]);

  // Wrap dispatch to clear activePaneId when the active pane is closed
  const wrappedDispatch = useCallback(
    (action: LayoutAction) => {
      if (action.type === "CLOSE_PANE" && action.paneId === activePaneIdRef.current) {
        setActivePaneId(null);
      }
      dispatch(action);
    },
    [dispatch]
  );

  // Stable callback — reads latest layout/activePaneId via refs to avoid stale closures
  const handleNavigate = useCallback(
    (path: string) => {
      const currentActivePaneId = activePaneIdRef.current;
      const curRoot = getActiveWorkspaceGroup(layoutRef.current)?.root;
      if (!curRoot) return;
      const targetPaneId = currentActivePaneId ?? findActivePane(curRoot)?.id;
      if (!targetPaneId) return;
      const pane = findPaneById(curRoot, targetPaneId);
      if (!pane) return;
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
      if (!tab || tab.paneType !== "file") return;
      setActiveTreePath(path);
      dispatch({
        type: "UPDATE_TAB",
        paneId: pane.id,
        tabId: tab.id,
        patch: { path, title: path.split(/[\\/]/).pop() || path },
      });
    },
    [dispatch, setActiveTreePath]
  );

  const handleGlobalKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Ctrl+Shift+P → command palette (allow from input too)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "P") {
        e.preventDefault();
        setShowCommandPalette(true);
        return;
      }

      // 編集要素（INPUT / TEXTAREA / contenteditable, xterm の hidden textarea 含む）に
      // フォーカスがあるときは、以降のアプリ用ショートカット（Undo/Redo・ファイル操作）を
      // 発火させず、ブラウザ標準の入力操作（Ctrl+A/Z/Y/C/V/X 等）に委ねる。
      {
        const tgt = e.target as HTMLElement;
        if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable) return;
      }

      // Ctrl+Z → undo last file operation
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        const op = undoOp();
        if (op) performUndo(op);
        return;
      }

      // Ctrl+Y → redo last undone file operation
      if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault();
        const op = redoOp();
        if (op) performRedo(op);
        return;
      }

      const kbRoot = getActiveWorkspaceGroup(layoutRef.current)?.root;
      const currentPaneId = activePaneIdRef.current ?? (kbRoot ? findActivePane(kbRoot)?.id : null) ?? null;
      if (!currentPaneId) return;

      if (matchBinding(bindings, e, "tab.new")) {
        e.preventDefault();
        dispatch({
          type: "ADD_TAB",
          paneId: currentPaneId,
          tab: {
            id: genId(),
            paneType: "file",
            title: "Home",
            path: "",
            history: [],
            historyIndex: 0,
          },
        });
        return;
      }

      if (matchBinding(bindings, e, "tab.close")) {
        e.preventDefault();
        const kbRoot2 = getActiveWorkspaceGroup(layoutRef.current)?.root;
        const pane = kbRoot2 ? findPaneById(kbRoot2, currentPaneId) : null;
        if (!pane) return;
        dispatch({ type: "CLOSE_TAB", paneId: currentPaneId, tabId: pane.activeTabId });
        return;
      }
    },
    [bindings, dispatch, undoOp, performUndo, redoOp, performRedo]
  );

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const palRoot = getActiveWorkspaceGroup(layout)?.root;
    const currentPaneId = activePaneId ?? (palRoot ? findActivePane(palRoot)?.id : null) ?? null;
    return [
      { id: "trash",    label: t("commandPalette.openTrash"),       icon: "delete",       action: () => {
        if (!currentPaneId) return;
        dispatch({ type: "ADD_TAB", paneId: currentPaneId, tab: { id: genId(), paneType: "trash", title: t("commandPalette.trashTabTitle") } });
      }},
      { id: "folder-compare", label: t("commandPalette.openFolderCompare"),    icon: "difference",    action: () => openFolderCompareWindow() },
      { id: "duplicates",    label: t("commandPalette.detectDuplicates"),       icon: "content_copy",  action: () => setShowDuplicatePanel(true) },
      { id: "op-queue",     label: t("commandPalette.toggleQueue"),        icon: "queue",         action: () => openQueueWindow() },
      { id: "git",      label: t("commandPalette.toggleGit"),      icon: "account_tree", action: () => setShowGitPanel((v) => !v) },
      { id: "tasks",    label: t("commandPalette.toggleTasks"),    icon: "play_circle",  action: () => toggleTaskPanel() },
      { id: "preview",  label: t("commandPalette.togglePreview"),       icon: "preview",      action: () => setShowPreviewPanel((v) => !v) },
      { id: "left-panel", label: t("commandPalette.toggleLeftPanel"), icon: "view_sidebar", action: () => setShowLeftPanel((v) => !v) },
      { id: "bookmark", label: t("commandPalette.toggleBookmark"),     icon: "star",         action: () => { if (showLeftPanel && leftPanelTab === "bookmark") { setShowLeftPanel(false); } else { setLeftPanelTab("bookmark"); localStorage.setItem("kf-left-panel-tab", "bookmark"); setShowLeftPanel(true); } } },
      { id: "addon",    label: t("commandPalette.openAddonManager"),     icon: "extension",    action: () => openSettingsWindow("addon") },
      { id: "tab.new",  label: t("commandPalette.openNewTab"),       icon: "add",          action: () => {
        if (!currentPaneId) return;
        dispatch({ type: "ADD_TAB", paneId: currentPaneId, tab: { id: genId(), paneType: "file", title: "Home", path: "", history: [], historyIndex: 0 } });
      }},
      { id: "split.h",  label: t("commandPalette.splitHorizontal"),               icon: "vertical_split",   action: () => {
        if (!currentPaneId) return;
        dispatch({ type: "SPLIT_PANE", paneId: currentPaneId, direction: "horizontal" });
      }},
      { id: "split.v",  label: t("commandPalette.splitVertical"),               icon: "horizontal_split", action: () => {
        if (!currentPaneId) return;
        dispatch({ type: "SPLIT_PANE", paneId: currentPaneId, direction: "vertical" });
      }},
    ];
  }, [activePaneId, layout, dispatch, t]);

  const compareContextValue = useMemo(() => ({
    enabled: showFolderCompare,
    registerEntries,
    paneEntries: paneEntriesMap,
    getDiffStatus,
  }), [showFolderCompare, registerEntries, paneEntriesMap, getDiffStatus]);

  const queueContextValue = useMemo(() => ({
    items: queueItems,
    paused: queuePaused,
    enqueue: enqueueOps,
    cancelItem: cancelQueueItem,
    retryItem: retryQueueItem,
    clearCompleted: clearCompletedQueue,
    setPaused: setQueuePaused,
  }), [queueItems, queuePaused, enqueueOps, cancelQueueItem, retryQueueItem, clearCompletedQueue, setQueuePaused]);

  const undoContextValue = useMemo(() => ({
    push: pushOp,
    undo: undoOp,
    canUndo: undoStack.length > 0,
    redo: redoOp,
    canRedo: redoStack.length > 0,
  }), [pushOp, undoOp, undoStack.length, redoOp, redoStack.length]);

  return (
    <OperationQueueContext.Provider value={queueContextValue}>
    <UndoContext.Provider value={undoContextValue}>
    <StatusContext.Provider value={{ status: statusInfo, setStatus }}>
      <CompareContext.Provider value={compareContextValue}>
      <LayoutContext.Provider value={{ layout, dispatch: wrappedDispatch, activePaneId, setActivePaneId, setActiveTreePath, previewPaneId, setPreviewPaneId, previewFilePath }}>
        <div
          className="w-full h-full flex flex-col"
          style={{
            backgroundColor: "var(--kf-bg-primary)",
            color: "var(--kf-text-primary)",
          }}
          onKeyDown={handleGlobalKeyDown}
          tabIndex={-1}
          data-testid="layout-root"
        >
          {/* ── グループバー兼タイトルバー（ウィンドウ最上段） ──────────────
              フルパス表示は廃止し、グループタブをそのままウィンドウヘッダに
              統合する。空き領域はドラッグでウィンドウ移動、ダブルクリックで
              最大化。OS のウィンドウ操作ボタンも左右端に配置する。 */}
          <div
            data-tauri-drag-region
            onDoubleClick={(e) => {
              // グループタブや分割ボタン等の子要素からバブリングしてきた
              // ダブルクリックでは最大化しない（タブ名変更ダイアログを開く
              // 操作と衝突するため）。ドラッグ領域そのもの（バー背景・空き
              // 領域）を直接ダブルクリックしたときだけ最大化する。
              if ((e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) toggleMax();
            }}
            className="flex items-stretch gap-0.5 shrink-0 border-b"
            style={{
              backgroundColor: "var(--kf-bg-secondary)",
              borderColor: "var(--kf-border)",
              minHeight: isMac ? MAC_HEADER_MIN_HEIGHT : 38,
              // Windows/Linux は自前バーの上端に少し余白を入れて重心を下げる。
              // macOS は純正 traffic light と同じ高さに揃えたいので中央寄せのまま。
              paddingTop: isMac ? 0 : 4,
            }}
          >
            {/* macOS は titleBarStyle: "Overlay" で純正の traffic light が
                webview の左上に重なって描かれる。その分の場所を空けるだけで、
                自前の丸ボタンは描かない（純正ならフルスクリーン・タイリング・
                非アクティブ時のグレーアウトまで OS が面倒を見てくれる）。 */}
            {isMac && (
              <div
                data-tauri-drag-region
                aria-hidden
                className="self-stretch shrink-0"
                style={{ width: MAC_TRAFFIC_LIGHT_INSET }}
              />
            )}
            {/* アプリアイコン（ヘッダー左端）。ドラッグ領域の一部として振る舞う。
                macOS はタイトルバーにアプリアイコンを置かない作法なので出さない
                （Dock とメニューバーが同じ役目を果たしている）。 */}
            {!isMac && (
              <img
                src={appIcon}
                alt=""
                aria-hidden
                draggable={false}
                className="self-center select-none"
                style={{ width: 16, height: 16, marginLeft: 10, flexShrink: 0, pointerEvents: "none" }}
              />
            )}
            <div className="flex items-center gap-0.5 px-2 flex-1 min-w-0">
            {layout.groups.map((group) => {
              const isActive = group.id === layout.activeGroupId;
              const color = group.color ?? GROUP_COLORS[0];
              const tabCount = countAllTabs(group.root);
              const isDragTarget = dragOverGroupId === group.id && dragGroupId !== group.id;
              return (
                <button
                  key={group.id}
                  data-group-id={group.id}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const groupId = group.id;
                    const groupLabel = group.label;
                    const startX = e.clientX;
                    const startY = e.clientY;
                    let dragActive = false;
                    let ghost: DragGhost | null = null;
                    // 押下した瞬間から grabbing 表示（cleanup が全終了経路で外す）
                    document.body.classList.add("kf-dragging");

                    // up / cancel / blur すべての終了経路で必ず呼ぶ後始末
                    // （pointercancel を取り逃すとリスナーが残留して応答不能の原因になる）
                    const cleanup = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      window.removeEventListener("pointercancel", onCancel);
                      window.removeEventListener("blur", onCancel);
                      document.body.classList.remove("kf-dragging");
                      ghost?.destroy();
                      ghost = null;
                      setDragGroupId(null);
                      setDragOverGroupId(null);
                    };

                    const onMove = (me: PointerEvent) => {
                      if (!dragActive) {
                        if (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5) {
                          dragActive = true;
                          setDragGroupId(groupId);
                          ghost = createDragGhost(groupLabel);
                        }
                      }
                      if (dragActive) {
                        ghost?.move(me.clientX, me.clientY);
                        const els = document.elementsFromPoint(me.clientX, me.clientY);
                        const targetEl = els.find(
                          (el) => el.hasAttribute("data-group-id") && el.getAttribute("data-group-id") !== groupId
                        );
                        const newId = targetEl?.getAttribute("data-group-id") ?? null;
                        setDragOverGroupId((prev) => (prev !== newId ? newId : prev));
                      }
                    };

                    const onCancel = () => cleanup();

                    const onUp = (ue: PointerEvent) => {
                      const wasDragging = dragActive;
                      cleanup();

                      if (wasDragging) {
                        const els = document.elementsFromPoint(ue.clientX, ue.clientY);
                        const targetEl = els.find(
                          (el) => el.hasAttribute("data-group-id") && el.getAttribute("data-group-id") !== groupId
                        );
                        const targetId = targetEl?.getAttribute("data-group-id");
                        if (targetId) {
                          dispatch({ type: "REORDER_GROUP", groupId, targetGroupId: targetId });
                        }
                      }
                    };

                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                    window.addEventListener("pointercancel", onCancel);
                    window.addEventListener("blur", onCancel);
                  }}
                  onClick={() => dispatch({ type: "SET_ACTIVE_GROUP", groupId: group.id })}
                  onDoubleClick={(e) => {
                    // 名前部分のダブルクリック → 変更ポップアップを開いて名前編集にフォーカス
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setRenameValue(group.label);
                    setGroupMenu({ x: r.left, y: r.bottom + 4, groupId: group.id, editName: true });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setRenameValue(group.label);
                    setGroupMenu({ x: e.clientX, y: e.clientY, groupId: group.id });
                  }}
                  className="flex items-center gap-1.5 px-2.5 rounded whitespace-nowrap select-none"
                  style={{
                    fontSize: 13,
                    // 非アクティブはペインのタブバーと同じ配合（bg-tertiary に
                    // border を混色）で塗り、バー背景から明確に浮かせる。
                    backgroundColor: isActive
                      ? `${color}22`
                      : "color-mix(in srgb, var(--kf-border) 45%, var(--kf-bg-tertiary))",
                    // 非アクティブは text-muted + opacity で二重に沈み、バー背景と
                    // 判別しづらかった。文字色を一段上げ、下辺の罫線も背景に近い
                    // border-soft ではなく border にしてタブの輪郭を明確にする。
                    color: isActive ? "var(--kf-text-primary)" : "var(--kf-text-secondary)",
                    border: `1px solid ${isActive ? `${color}66` : "var(--kf-border)"}`,
                    borderBottom: `2px solid ${isActive ? color : "var(--kf-border)"}`,
                    borderLeft: isDragTarget ? "2px solid var(--kf-accent)" : `1px solid ${isActive ? `${color}66` : "var(--kf-border)"}`,
                    height: 30,
                    fontWeight: isActive ? 600 : 400,
                    // 非アクティブの opacity 低下はやめる（アクティブとの差は
                    // 背景色・文字色・下辺アクセント・太字で十分に付いている）。
                    // ドラッグ中の元タブだけ 0.4 に落として移動中であることを示す。
                    opacity: dragGroupId === group.id ? 0.4 : 1,
                    // 通常はクリック対象としての pointer。押下〜ドラッグ中は
                    // body.kf-dragging（全要素 grabbing !important）が上書きする
                    cursor: "pointer",
                    transition: "border-left-color 0.1s, opacity 0.1s",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: color, flexShrink: 0, display: "inline-block" }} />
                  {group.label}
                  <span
                    className="px-1 rounded-full"
                    style={{
                      fontSize: 10,
                      // 非アクティブ時はタブ本体と同色だとバッジが消えるため、
                      // タブより一段強い border 寄りの色で塗り分ける。
                      backgroundColor: isActive ? color : "var(--kf-border)",
                      color: isActive ? "#fff" : "var(--kf-text-secondary)",
                      minWidth: 16, textAlign: "center", lineHeight: "16px",
                    }}
                  >
                    {tabCount}
                  </span>
                </button>
              );
            })}
            <button
              onClick={() => {
                const n = layout.groups.length + 1;
                dispatch({ type: "CREATE_GROUP", label: `Group ${n}` });
              }}
              className="flex items-center opacity-60 hover:opacity-100 px-0.5"
              title={t("layoutRoot.addGroup")}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>add</span>
            </button>

            {/* 空き領域 = ウィンドウドラッグ領域 */}
            <div data-tauri-drag-region className="flex-1 self-stretch" />
            {/* ── ペイン分割（1 ボタン + ポップオーバーに集約） ─────────────
                以前は 10 個の極小ボタンが常時並んでいたが、判別しづらく
                タイトルバーを圧迫していたため、現在の分割形を示す 1 ボタンに
                まとめ、プリセット一覧はポップオーバーで提示する（機能は全維持）。 */}
            <div
              ref={splitMenuRef}
              className="relative flex items-center px-1 shrink-0"
              style={{ borderLeft: "1px solid var(--kf-border)", marginLeft: 4 }}
            >
              <button
                onClick={() => setSplitMenuOpen((v) => !v)}
                title={t("layoutRoot.splitMenuButton")}
                className="flex items-center gap-1 rounded px-1.5 transition-colors"
                style={{
                  height: 24,
                  color: splitMenuOpen ? "var(--kf-text-primary)" : "var(--kf-text-secondary)",
                  backgroundColor: splitMenuOpen ? "var(--kf-bg-tertiary)" : "transparent",
                  border: "1px solid " + (splitMenuOpen ? "var(--kf-border)" : "transparent"),
                }}
              >
                <SplitIcon pattern={currentSplitPattern ?? [1]} />
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_drop_down</span>
              </button>
              {splitMenuOpen && (
                <div
                  className="kf-surface-menu absolute z-50 p-2"
                  style={{ top: "calc(100% + 4px)", right: 0, minWidth: 230 }}
                >
                  <div className="px-1 pb-1.5 opacity-60" style={{ fontSize: 10 }}>
                    {t("layoutRoot.splitMenuTitle")}
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {UNIFORM_SPLITS.map(renderSplitPreset)}
                  </div>
                  {/* 段ごとにペイン数が異なるプリセット（上 2・下 1 など）。均等格子と
                      混ぜると目当ての形を探しづらいので、見出しを付けて分けて並べる。 */}
                  <div className="px-1 pt-2 pb-1.5 opacity-60" style={{ fontSize: 10 }}>
                    {t("layoutRoot.splitMenuAsymmetric")}
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {ASYMMETRIC_SPLITS.map(renderSplitPreset)}
                  </div>
                </div>
              )}
            </div>
            </div>
            {!isMac && (
              <WinCaptionButtons
                maximized={maximized}
                onMinimize={minimize}
                onToggleMax={toggleMax}
                onClose={close}
              />
            )}
          </div>

          {/* グループコンテキストメニュー */}
          {groupMenu && (
            <div
              ref={groupMenuRef}
              className="kf-surface-menu fixed z-50 py-1 text-xs min-w-[160px]"
              style={{
                left: groupMenuPos.x, top: groupMenuPos.y,
                color: "var(--kf-text-primary)",
              }}
            >
              {/* グループ名の編集（Enter で確定・Escape でキャンセル・外側クリックでも確定） */}
              <div className="px-3 pt-1 pb-1.5 flex flex-col gap-1">
                <span className="opacity-50" style={{ fontSize: 10 }}>{t("layoutRoot.groupName")}</span>
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      commitGroupMenuRename(groupMenu.groupId);
                      setGroupMenu(null);
                    }
                  }}
                  className="px-2 py-1 rounded outline-none w-full"
                  style={{
                    fontSize: 12,
                    backgroundColor: "var(--kf-bg-primary)",
                    color: "var(--kf-text-primary)",
                    border: "1px solid var(--kf-border)",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "var(--kf-accent)")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "var(--kf-border)")}
                />
              </div>
              {/* カラー選択 */}
              <div className="border-t my-1" style={{ borderColor: "var(--kf-border)" }} />
              <div className="px-3 py-0.5 opacity-50" style={{ fontSize: 10 }}>{t("layoutRoot.groupColor")}</div>
              <div className="flex items-center gap-1.5 px-3 py-1.5 flex-wrap">
                {GROUP_COLORS.map((c) => {
                  const g = layout.groups.find((g) => g.id === groupMenu.groupId);
                  return (
                    <button
                      key={c}
                      onClick={() => {
                        dispatch({ type: "SET_GROUP_COLOR", groupId: groupMenu.groupId, color: c });
                        commitGroupMenuRename(groupMenu.groupId);
                        setGroupMenu(null);
                      }}
                      style={{
                        width: 16, height: 16, borderRadius: "50%", backgroundColor: c,
                        border: g?.color === c ? "2px solid var(--kf-text-primary)" : "2px solid transparent",
                        flexShrink: 0,
                      }}
                    />
                  );
                })}
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="opacity-50" style={{ fontSize: 10 }}>{t("layoutRoot.customColor")}</span>
                <input
                  key={groupMenu.groupId}
                  ref={colorInputRef}
                  type="color"
                  defaultValue={layout.groups.find((g) => g.id === groupMenu.groupId)?.color ?? GROUP_COLORS[0]}
                  style={{ width: 24, height: 24, border: "none", padding: 0, cursor: "pointer", borderRadius: 4, backgroundColor: "transparent" }}
                />
                <button
                  onClick={() => {
                    const color = colorInputRef.current?.value;
                    if (color) dispatch({ type: "SET_GROUP_COLOR", groupId: groupMenu.groupId, color });
                    commitGroupMenuRename(groupMenu.groupId);
                    setGroupMenu(null);
                  }}
                  className="px-2 py-0.5 rounded text-xs hover:opacity-80"
                  style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)", fontSize: 10 }}
                >
                  {t("layoutRoot.apply")}
                </button>
              </div>
              {layout.groups.length > 1 && (
                <>
                  <div className="border-t my-1" style={{ borderColor: "var(--kf-border)" }} />
                  <button
                    className="kf-menu-item flex items-center gap-2 w-full px-2.5 mx-1 text-left"
                    style={{ color: "var(--kf-error)" }}
                    onClick={() => { dispatch({ type: "DELETE_GROUP", groupId: groupMenu.groupId }); setGroupMenu(null); }}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 13 }}>close</span>
                    {t("layoutRoot.deleteGroup")}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="flex-1 overflow-hidden flex">
            <ActivityBar
              showLeftPanel={showLeftPanel}
              leftPanelTab={leftPanelTab}
              onSelectLeftTab={(tab) => {
                if (showLeftPanel && leftPanelTab === tab) {
                  setShowLeftPanel(false);
                } else {
                  setLeftPanelTab(tab);
                  localStorage.setItem("kf-left-panel-tab", tab);
                  setShowLeftPanel(true);
                }
              }}
              showIndexPanel={showIndexPanel}
              onToggleIndexPanel={() => setShowIndexPanel((v) => !v)}
              showTagPanel={showTagPanel}
              onToggleTagPanel={() => setShowTagPanel((v) => !v)}
              showRulePanel={showRulePanel}
              onToggleRulePanel={() => setShowRulePanel((v) => !v)}
              showSyncPanel={showSyncPanel}
              onToggleSyncPanel={() => setShowSyncPanel((v) => !v)}
              showGrepPanel={showGrepPanel}
              onToggleGrepPanel={() => setShowGrepPanel((v) => !v)}
              showQueuePanel={false}
              onToggleQueuePanel={openQueueWindow}
              showGitPanel={showGitPanel}
              onToggleGitPanel={() => setShowGitPanel((v) => !v)}
              showTaskPanel={showTaskPanel}
              onToggleTaskPanel={() => toggleTaskPanel()}
              showFolderCompare={showFolderCompare}
              onToggleFolderCompare={openFolderCompareWindow}
              openAddonId={openAddonId}
              onToggleAddon={(id) => setOpenAddonId((prev) => (prev === id ? null : id))}
              loadedAddonIds={Array.from(loaded.keys())}
              onOpenSettings={() => openSettingsWindow()}
            />
            {showLeftPanel && (
              <ErrorBoundary>
                <LeftSidePanel
                  tab={leftPanelTab}
                  currentPath={activePath}
                  onNavigate={handleNavigate}
                />
              </ErrorBoundary>
            )}
            <div className="flex-1 overflow-hidden flex">
              {activeRoot && (
              <ErrorBoundary variant="fill">
                <LayoutRenderer
                  node={activeRoot}
                  onSelectFile={handleSelectFile}
                />
              </ErrorBoundary>
              )}
            </div>
            {showGitPanel && <ErrorBoundary><GitPanel activePath={activePath} onClose={() => setShowGitPanel(false)} /></ErrorBoundary>}
            {taskPanelMounted && (
              <ErrorBoundary>
                <TaskRunnerPanel
                  currentPath={activePath}
                  hidden={!showTaskPanel}
                  onClose={() => setShowTaskPanel(false)}
                />
              </ErrorBoundary>
            )}
            {showPreviewPanel && <ErrorBoundary><PreviewPanel filePath={previewFilePath} onClose={() => setShowPreviewPanel(false)} /></ErrorBoundary>}
            {showGrepPanel && <ErrorBoundary><GrepPanel currentPath={activePath} onOpenFile={setPreviewFilePath} onClose={() => setShowGrepPanel(false)} /></ErrorBoundary>}
            {showIndexPanel && <ErrorBoundary><IndexSearchPanel currentPath={activePath} onNavigate={handleNavigate} onOpenFile={setPreviewFilePath} onClose={() => setShowIndexPanel(false)} /></ErrorBoundary>}
            {showTagPanel && <ErrorBoundary><TagSearchPanel activeFilePath={previewFilePath} onNavigate={handleNavigate} onOpenFile={setPreviewFilePath} onClose={() => setShowTagPanel(false)} /></ErrorBoundary>}
            {showRulePanel && <ErrorBoundary><RuleManagerPanel onClose={() => setShowRulePanel(false)} /></ErrorBoundary>}
            {showSyncPanel && <ErrorBoundary><CloudSyncPanel onClose={() => setShowSyncPanel(false)} /></ErrorBoundary>}
            {openAddonId && (
              <ErrorBoundary>
                <AddonPanel
                  addonId={openAddonId}
                  currentPath={activePath}
                  paneId={activePaneId ?? undefined}
                  onClose={() => setOpenAddonId(null)}
                />
              </ErrorBoundary>
            )}
          </div>
          <StatusBar />
        </div>
        <ProgressOverlay />
        <ToastHost />
        {showCommandPalette && (
          <CommandPalette commands={paletteCommands} onClose={() => setShowCommandPalette(false)} />
        )}
        {showDuplicatePanel && (
          <DuplicatePanel
            currentPath={activePath}
            onClose={() => setShowDuplicatePanel(false)}
          />
        )}
      </LayoutContext.Provider>
      </CompareContext.Provider>
    </StatusContext.Provider>
    </UndoContext.Provider>
    </OperationQueueContext.Provider>
  );
}

function findPaneById(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.type === "pane") {
    return node.id === paneId ? node : null;
  }
  for (const child of node.children) {
    const found = findPaneById(child, paneId);
    if (found) return found;
  }
  return null;
}

export default function LayoutRoot() {
  return (
    <AddonProvider>
      <KeybindingProvider>
        <LayoutRootInner />
      </KeybindingProvider>
    </AddonProvider>
  );
}
