import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { openPath as openWithDefaultApp, revealItemInDir } from "@tauri-apps/plugin-opener";
import { FileEntry } from "../../types/fs";
import { useLayout, genId } from "../../store/layoutStore";
import { FileTab } from "../../types/layout";
import { useFileListShortcuts } from "../../hooks/useFileListShortcuts";
import { addBookmark } from "../../lib/bookmarks";
import PropertiesDialog from "../dialogs/PropertiesDialog";
import ContextMenu from "../common/ContextMenu";
import ContextMenuEditor from "../dialogs/ContextMenuEditor";
import TagDialog from "../dialogs/TagDialog";
import ArchiveBrowser from "../viewers/ArchiveBrowser";
import BatchRenameDialog from "../dialogs/BatchRenameDialog";
import DiffViewer from "../viewers/DiffViewer";
import ImageViewer from "../viewers/ImageViewer";
import ConflictDialog, { ConflictResolution } from "../dialogs/ConflictDialog";
import CompressDialog from "../dialogs/CompressDialog";
import QuickPreviewModal, { isTextViewable } from "../dialogs/QuickPreviewModal";
import { openMarkdownViewerWindow } from "../../lib/viewerWindow";
import { useVolumesChanged } from "../../lib/volumeWatch";
import { isMtpPath, downloadMtpEntry, planMtpTransfer } from "../../lib/mtp";
import { showToast } from "../../lib/toast";
import DiskTreemap from "../viewers/DiskTreemap";
import Icon from "../common/Icon";
import { useStatus } from "../../store/statusStore";
import { useCompare } from "../../store/compareStore";
import { useUndo } from "../../store/undoStore";
import { CustomMenuItem, SortKey } from "../../types/fileListTypes";
import { useFileFilter, COLOR_LABEL_COLORS, PRESET_EXTS, GrepMatch } from "../../hooks/useFileFilter";
import { APP_EVENTS } from "../../lib/appEvents";
import { isProjectManifestFile } from "../../lib/projectTasks";
import { usePaneWidth, paneDensity } from "../../hooks/usePaneWidth";
import { applyFileDragImage } from "../../lib/fileDragImage";
import {
  INTERNAL_DRAG_TYPE, setActiveDrag, clearActiveDrag, readInternalDrag, isInternalDrag,
  internalDropEffect, beginNativeFileDrag,
} from "../../lib/nativeFileDrag";
import { useOperationQueue } from "../../store/operationQueueStore";
import { useUiSettings } from "../../store/uiSettingsStore";
import { useClipboard } from "../../store/clipboardStore";
import { useKeybindings, shortcutLabelFor } from "../../store/keybindingStore";
import { useColorLabels } from "../../store/colorLabelStore";
import { useTags } from "../../store/tagStore";
import { useFollowPathChange } from "../../hooks/useFollowPathChange";
import { IMAGE_EXTS, ALL_OPTIONAL_COLS, OptionalCol } from "./constants";
import HighlightName from "./HighlightName";
import { formatSize, formatDate } from "./format";
import FileIcon from "./FileIcon";
import SortIcon from "./SortIcon";
import FileRow, { RowLabels } from "./FileRow";
import PathAutocomplete from "./PathAutocomplete";
import FileListViewControls from "./FileListViewControls";
import { useDirEntries } from "./useDirEntries";
import FileListHomeView from "./FileListHomeView";
import { useDialogState } from "./useDialogState";
import { useViewSettings } from "./useViewSettings";
import { stepView } from "./viewZoom";
import { useTableColumns } from "./useTableColumns";
import { useCreation } from "./useCreation";
import FileListFilterPanel from "./FileListFilterPanel";
import FileListSearchBar from "./FileListSearchBar";
import FileListFilterPresets from "./FileListFilterPresets";
import { HAS_SHELL_COMMANDS } from "../../buildConfig";

type Props = {
  paneId: string;
  tab: FileTab;
  onSelectFile?: (path: string | null) => void;
};


export default function FileList({ paneId, tab, onSelectFile }: Props) {
  const { t } = useTranslation();
  const { dispatch, setActivePaneId, setActiveTreePath } = useLayout();
  const { setStatus } = useStatus();
  const { enabled: compareEnabled, registerEntries, paneEntries } = useCompare();
  const { push: pushUndo } = useUndo();
  const { enqueue } = useOperationQueue();
  const [{ showColumnDividers, showRowDividers, autoCalcDirSizes, fileAssociations, previewExtConfig, iconSet }, setUiSettings] = useUiSettings();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [clipboard, setClipboard] = useClipboard();
  // コンテキストメニューの右端に現在のキーバインドをヒント表示するため参照
  const { bindings } = useKeybindings();
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const {
    propertiesPath, setPropertiesPath,
    archiveBrowserPath, setArchiveBrowserPath,
    showBatchRename, setShowBatchRename,
    diffPaths, setDiffPaths,
    compressTargets, setCompressTargets,
    conflictInfo, setConflictInfo,
    quickPreviewPath, setQuickPreviewPath,
    imageViewer, setImageViewer,
  } = useDialogState();

  const { viewMode, setViewMode, gridItemSize, setGridItemSize, dateRelative, setDateRelative, searchActive, setSearchActive } = useViewSettings({ tabId: tab.id });
  // 一覧表示はサムネイル表示と同じタイルの土台を使い、レイアウトだけを詰める。
  const isCompact = viewMode === "compact";

  // ホイールのネイティブリスナーは一度だけ張るため、現在値は ref から読む。
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const gridItemSizeRef = useRef(gridItemSize);
  gridItemSizeRef.current = gridItemSize;

  /**
   * 表示形式を密度の梯子で一段動かす（Ctrl + ホイール / Ctrl + "+" "-"）。
   * 詳細 → 一覧 → サムネイル小 → サムネイル大 の順。
   */
  const stepViewMode = useCallback((direction: 1 | -1) => {
    const next = stepView(viewModeRef.current, gridItemSizeRef.current, direction);
    setViewMode(next.mode);
    localStorage.setItem(`kf-view-mode-${tab.id}`, next.mode);
    if (next.gridSize !== undefined) {
      setGridItemSize(next.gridSize);
      localStorage.setItem(`kf-grid-size-${tab.id}`, String(next.gridSize));
    }
  }, [setViewMode, setGridItemSize, tab.id]);

  const { colWidths, visibleCols, setVisibleCols, headerMenuPos, setHeaderMenuPos, headerMenuRef, startColResize } = useTableColumns({ tabId: tab.id });

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    screenX: number;
    screenY: number;
    entry: FileEntry;
    paths: string[];
  } | null>(null);
  // 空白部分の右クリックメニュー（貼り付け・新規作成・更新）
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  // OS クリップボードにファイルリストが載っているか（エクスプローラーのコピー等）
  const [osClipboardHasFiles, setOsClipboardHasFiles] = useState(false);
  const [customMenuItems, setCustomMenuItems] = useState<CustomMenuItem[]>([]);
  const [showMenuEditor, setShowMenuEditor] = useState(false);
  const [dirSizes, setDirSizes] = useState<Map<string, number | "loading">>(new Map());
  const [showDirSizes, setShowDirSizes] = useState(false);
  const [showTreemap, setShowTreemap] = useState(false);
  const [syncNavEnabled, setSyncNavEnabled] = useState(() => localStorage.getItem("kf-sync-nav") === "1");
  const [homePath, setHomePath] = useState<string>(() => localStorage.getItem("kf-home-path") ?? "");
  const [showHomeMenu, setShowHomeMenu] = useState<{ x: number; y: number } | null>(null);
  const homeMenuRef = useRef<HTMLDivElement>(null);
  const [patternDialog, setPatternDialog] = useState<"add" | "remove" | null>(null);
  const [patternInput, setPatternInput] = useState("");
  const [volumes, setVolumes] = useState<{ path: string; label: string; kind: "fixed" | "removable" | "unknown" }[]>([]);
  const [homeBookmarks, setHomeBookmarks] = useState<{ name: string; path: string }[]>([]);
  const [homeRecent, setHomeRecent] = useState<string[]>([]);
  const [rubberBand, setRubberBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const rubberBandStartRef = useRef<{ x: number; y: number; containerRect: DOMRect } | null>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const quickJumpBufferRef = useRef("");
  const quickJumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  /**
   * Ctrl + ホイールで表示形式を一段ずつ動かす。
   *
   * React の onWheel ではなくネイティブリスナーを直に張るのは、preventDefault
   * が要るため。付けないと WebView 側の既定動作（ページ全体の拡大縮小）が
   * 走ってしまい、アプリの UI ごと拡大される。
   */
  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      // 上へ回す（deltaY < 0）と拡大方向。
      stepViewMode(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stepViewMode]);

  const scrollParentRef = useRef<HTMLDivElement>(null);
  const isCommittingRenameRef = useRef(false);
  const isCancelingRenameRef = useRef(false);

  const navResetRef = useRef<() => void>(() => {});
  const {
    entries,
    currentPath,
    loading,
    loadingPath,
    error,
    setError,
    navigate,
    navigateUser,
    cancelNavigation,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
  } = useDirEntries({
    tabPath: tab.path,
    tabId: tab.id,
    initialHistory: tab.history,
    initialHistoryIndex: tab.historyIndex,
    paneId,
    dispatch,
    setActivePaneId,
    setActiveTreePath,
    syncNavEnabled,
    onNavigateReset: () => navResetRef.current(),
  });

  // --- Filter / Search / Sort (extracted to useFileFilter) ---
  const {
    searchQuery, setSearchQuery,
    searchMode, setSearchMode,
    recursiveLoading, cancelSearch,
    grepResults, grepLoading, cancelGrepSearch,
    filterPreset, setFilterPreset,
    labelFilter, setLabelFilter,
    showAdvFilter, setShowAdvFilter,
    sizeMin, setSizeMin,
    sizeMax, setSizeMax,
    sizeUnit, setSizeUnit,
    dateMin, setDateMin,
    dateMax, setDateMax,
    sortKey, sortDir, handleSort,
    pinnedPaths, handleTogglePin,
    filteredEntries,
    displayEntries,
    isRecursiveActive,
    isContentActive,
  } = useFileFilter({ entries, currentPath, tabId: tab.id });

  const { colorLabels, setColorLabel: handleSetColorLabel } = useColorLabels();
  const { getTags: getFileTags } = useTags();
  // 移動/リネームでタグ・カラーラベルを付け替える
  const followPathChange = useFollowPathChange();
  // 右クリックから開くタグ編集ダイアログの対象パス（null = 閉じている）
  const [tagDialogPaths, setTagDialogPaths] = useState<string[] | null>(null);

  // 現在のフォルダ（再帰検索中はその結果）で実際に使われているラベル色。
  // フィルタ行には使われている色だけを出す。
  const availableLabels = useMemo(() => {
    const seen = new Set<string>();
    for (const e of entries) {
      const c = colorLabels[e.path];
      if (c) seen.add(c);
    }
    // 絞り込み中の色は、対象が 0 件になっても消えないよう必ず残す
    // （消えると解除する手段がなくなり、空の一覧から抜け出せなくなる）。
    if (labelFilter) seen.add(labelFilter);
    return Array.from(seen);
  }, [entries, colorLabels, labelFilter]);

  const {
    creatingType, setCreatingType,
    creatingName, setCreatingName,
    templates,
    selectedTemplate, setSelectedTemplate,
    creatingInputRef,
    handleCreate,
  } = useCreation({ currentPath, navigate, setSelected, setError, t });

  // このペインが開始した走査（フォルダサイズ計算など）をまとめて識別するトークン。
  // 別パスへ移動するときはこのトークンでバックエンドの走査を打ち切る。
  const scanTokenRef = useRef(`filelist:${paneId}:${tab.id}`);
  // 走査の世代。移動やキャンセルのたびに進め、古い走査の結果を捨てる。
  const scanSeqRef = useRef(0);

  /** 進行中のフォルダサイズ計算をバックエンドごと打ち切る。 */
  const cancelDirSizeScans = useCallback(async () => {
    scanSeqRef.current++;
    try {
      await invoke("cancel_scan", { token: scanTokenRef.current });
    } catch {
      // 走査が無ければ何もしない
    }
  }, []);

  // ナビゲーション時に選択・フォーカスをリセット（useDirEntries から ref 経由で呼ばれる）。
  // 検索語は維持する: 移動のたびに消えると入力し直しになるため（絞り込み中は
  // 検索バーが強調表示され、一致なしの空表示からワンクリックで解除できる）。
  navResetRef.current = () => {
    setSelected(new Set());
    setFocusedIndex(0);
    // 移動を始めた時点で、いま見ているフォルダのサイズ計算を止める。
    // 数十フォルダぶんの再帰走査が走ったままだと、ディスク I/O とスレッドを
    // 占有して移動先の読み込みがいつまでも始まらない。
    void cancelDirSizeScans();
  };

  // Resolve OS home dir if homePath not yet set
  useEffect(() => {
    if (homePath) return;
    invoke<string>("get_home_dir").then((p) => {
      setHomePath(p);
      localStorage.setItem("kf-home-path", p);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset dir sizes when directory changes
  useEffect(() => {
    setDirSizes(new Map());
    setShowDirSizes(false);
  }, [currentPath]);

  // ペインを閉じる・タブを切り替えるときも、走らせっぱなしの走査を残さない
  useEffect(() => {
    return () => { void cancelDirSizeScans(); };
  }, [cancelDirSizeScans]);

  // 設定が ON のときはエントリ更新後にフォルダサイズを自動計算。
  // FS 監視による再読込では entries の中身が同じでも配列が作り直されるため、
  // フォルダ構成が変わっていないときは再計算しない（フォルダごとの再帰走査を
  // 貼り付け中に何度も走らせると固まるため）。
  const dirSizeTargetsRef = useRef("");
  useEffect(() => {
    if (!autoCalcDirSizes || !currentPath) {
      dirSizeTargetsRef.current = "";
      return;
    }
    const dirs = entries.filter((e) => e.isDir);
    if (dirs.length === 0) {
      dirSizeTargetsRef.current = "";
      return;
    }
    const key = [currentPath, ...dirs.map((d) => d.path)].join(" ");
    if (dirSizeTargetsRef.current === key) return;
    dirSizeTargetsRef.current = key;
    calculateDirSizes(dirs);
  // calculateDirSizes は useCallback で安定しているが、entries/currentPath が変わったときのみ実行したい
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, currentPath, autoCalcDirSizes]);

  // ドライブ一覧の再取得（ホーム表示・抜き差し時に共用）。
  const reloadVolumes = useCallback(() => {
    invoke<{ path: string; label: string; kind: "fixed" | "removable" | "unknown" }[]>("list_volumes")
      .then(setVolumes)
      .catch(() => {});
  }, []);

  // Load home view data (volumes, bookmarks, recent) when path is empty
  useEffect(() => {
    if (currentPath) return;
    reloadVolumes();
    invoke<{ name: string; path: string }[]>("load_bookmarks")
      .then(setHomeBookmarks)
      .catch(() => {});
    try {
      const raw = localStorage.getItem("kf-recent-paths");
      setHomeRecent(raw ? (JSON.parse(raw) as string[]).slice(0, 10) : []);
    } catch { setHomeRecent([]); }
  }, [currentPath, reloadVolumes]);

  // USB / スマートフォン等の抜き差しでホームのドライブ一覧を自動更新する。
  useVolumesChanged(reloadVolumes);

  // Close home menu on outside click
  useEffect(() => {
    if (!showHomeMenu) return;
    const handler = (e: MouseEvent) => {
      if (homeMenuRef.current && !homeMenuRef.current.contains(e.target as Node)) {
        setShowHomeMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showHomeMenu]);

  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < displayEntries.length) {
      virtualizer.scrollToIndex(focusedIndex, { align: "auto" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedIndex]);

  const navigateUp = useCallback(async () => {
    const parent = await invoke<string | null>("get_parent_dir", { path: currentPath });
    if (parent) navigateUser(parent);
  }, [currentPath, navigateUser]);

  // ── 「場所を表示」: 親フォルダを開いてその項目を選択する ──────────────
  // ブックマークのラベル一覧からファイルを開いたときに使う。移動先の一覧が
  // 読み込まれるのを待ってから選択したいので、パスを保留して entries の
  // 到着後に解決する。
  const pendingRevealRef = useRef<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const { path } = (e as CustomEvent).detail as { path: string };
      if (!path) return;
      const parent = path.replace(/[\\/][^\\/]*$/, "") || path;
      pendingRevealRef.current = path;
      if (parent && parent !== currentPath) navigateUser(parent);
    };
    window.addEventListener(APP_EVENTS.REVEAL_PATH, handler);
    return () => window.removeEventListener(APP_EVENTS.REVEAL_PATH, handler);
  }, [currentPath, navigateUser]);

  // 保留中の「場所を表示」を、一覧が出そろった時点で選択に反映する。
  useEffect(() => {
    const target = pendingRevealRef.current;
    if (!target) return;
    const idx = displayEntries.findIndex((e) => e.path === target);
    if (idx === -1) {
      // まだ目的のフォルダを読み込めていないだけかもしれないので、
      // 現在地が目的の親と一致したときだけ「見つからない」と判断して諦める。
      const parent = target.replace(/[\\/][^\\/]*$/, "") || target;
      if (parent === currentPath) pendingRevealRef.current = null;
      return;
    }
    pendingRevealRef.current = null;
    setSelected(new Set([target]));
    setFocusedIndex(idx);
  }, [displayEntries, currentPath]);


  const onGridMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only start rubber-band on primary button clicks on empty space (not on item elements)
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-grid-item]")) return;
    e.preventDefault();
    const containerRect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - containerRect.left;
    const y = e.clientY - containerRect.top + (e.currentTarget as HTMLDivElement).scrollTop;
    rubberBandStartRef.current = { x, y, containerRect };
    setRubberBand({ x1: x, y1: y, x2: x, y2: y });
    setSelected(new Set());

    function onMove(ev: MouseEvent) {
      if (!rubberBandStartRef.current) return;
      const { x: sx, y: sy, containerRect: cr } = rubberBandStartRef.current;
      const scrollTop = gridContainerRef.current?.scrollTop ?? 0;
      const cx = ev.clientX - cr.left;
      const cy = ev.clientY - cr.top + scrollTop;
      setRubberBand({ x1: sx, y1: sy, x2: cx, y2: cy });

      // Select items whose bounding boxes intersect the rubber band
      if (!gridContainerRef.current) return;
      const minX = Math.min(sx, cx);
      const maxX = Math.max(sx, cx);
      const minY = Math.min(sy, cy);
      const maxY = Math.max(sy, cy);
      const items = gridContainerRef.current.querySelectorAll<HTMLElement>("[data-grid-item]");
      const newSel = new Set<string>();
      items.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const elTop = rect.top - cr.top + scrollTop;
        const elLeft = rect.left - cr.left;
        const elRight = elLeft + rect.width;
        const elBottom = elTop + rect.height;
        if (elLeft < maxX && elRight > minX && elTop < maxY && elBottom > minY) {
          const path = el.dataset.path;
          if (path) newSel.add(path);
        }
      });
      setSelected(newSel);
    }

    function onUp() {
      rubberBandStartRef.current = null;
      setRubberBand(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);


  // Register entries for compare mode
  useEffect(() => {
    registerEntries(paneId, displayEntries);
  }, [paneId, displayEntries, registerEntries]);

  // Sync selection/clipboard state to StatusBar.
  // Single-pass reduce (was 4 separate filter calls = 4× O(N) per state change).
  useEffect(() => {
    let folderCount = 0;
    let fileCount = 0;
    let selectedSize = 0;
    for (const e of displayEntries) {
      if (e.isDir) folderCount++;
      else fileCount++;
      if (!e.isDir && selected.has(e.path)) selectedSize += e.size;
    }
    // Filter activity: search query OR preset OR size/date filters
    const isFiltered =
      !!searchQuery.trim() ||
      filterPreset !== "all" ||
      !!sizeMin || !!sizeMax || !!dateMin || !!dateMax;
    setStatus({
      selectedCount: selected.size,
      totalCount: displayEntries.length,
      folderCount,
      fileCount,
      selectedSize,
      clipboard: clipboard ? { count: clipboard.paths.length, mode: clipboard.mode } : null,
      unfilteredCount: entries.length,
      hiddenCount: 0, // shown count is post-filter; hidden-file count is informational only
      isFiltered,
      viewMode,
      sortKey,
      sortDir,
    });
  }, [
    selected, displayEntries, clipboard, setStatus,
    searchQuery, filterPreset, sizeMin, sizeMax, dateMin, dateMax,
    entries.length, viewMode, sortKey, sortDir,
  ]);

  // ペイン幅に応じて中身の密度を変える（分割を増やすと 1 ペインが数百 px になる）。
  const paneWidth = usePaneWidth(listContainerRef);
  const density = paneDensity(paneWidth);
  // 極端に狭いペインでフィルタ行を手動で開いたか
  const [filterRowOpen, setFilterRowOpen] = useState(false);
  // 同じくアドレスバー。⌘L で開き、入力モードを抜けたら畳み直す。
  const [pathBarOpen, setPathBarOpen] = useState(false);
  const [pathBarOpenSignal, setPathBarOpenSignal] = useState(0);
  const openPathBar = useCallback(() => {
    setPathBarOpen(true);
    setPathBarOpenSignal((n) => n + 1);
  }, []);

  // 絞り込みが 1 つでも効いていれば、狭くてもフィルタ行は隠さない。
  // 隠したまま一覧が絞られていると、原因の分からない「空のフォルダ」になる。
  const filterActive =
    filterPreset !== "all" || labelFilter !== null || !!(sizeMin || sizeMax || dateMin || dateMax);
  const showFilterRow = density !== "minimal" || filterRowOpen || filterActive;

  // Memoize per-render derived data so child rows don't see new identities.
  //
  // ペインが狭いときは、収まらない任意列を自動で畳む。ユーザーの列設定
  // （visibleCols）は書き換えず、描画時に間引くだけなので、ペインを広げれば
  // そのまま戻る。畳まないと名前列が minmax の下限まで潰れ、ファイル名が
  // ほとんど読めなくなる（3×4 分割で顕著）。
  const visibleColsList = useMemo(() => {
    const wanted = ALL_OPTIONAL_COLS.filter((c) => visibleCols.has(c));
    if (!Number.isFinite(paneWidth)) return wanted;

    // 名前列に最低限残したい幅 + アイコン/余白のぶん。
    const NAME_MIN = 150;
    const CHROME = 44;
    // 優先度の低いものから外す（種類 → 拡張子 → 更新日 → サイズ）。
    const dropOrder: OptionalCol[] = ["type", "ext", "modified", "size"];

    const kept = new Set(wanted);
    const used = () => [...kept].reduce((sum, c) => sum + colWidths[c], 0);
    for (const col of dropOrder) {
      if (paneWidth - CHROME - used() >= NAME_MIN) break;
      kept.delete(col);
    }
    return wanted.filter((c) => kept.has(c));
  }, [visibleCols, colWidths, paneWidth]);
  const gridTemplate = useMemo(
    () =>
      `auto minmax(120px, 1fr) ${visibleColsList
        .map((c) => `${colWidths[c]}px`)
        .join(" ")}`,
    [visibleColsList, colWidths],
  );

  const estimateSize = useCallback((i: number) => {
    // Recursive search rows with a subdirectory path shown are taller
    if (isRecursiveActive) {
      const e = displayEntries[i];
      const relDir = e.path.slice(currentPath.length).replace(/[\\/][^\\/]+$/, "").replace(/^[\\/]/, "");
      return relDir && relDir !== "." ? 40 : 28;
    }
    return 28;
  }, [isRecursiveActive, displayEntries, currentPath]);

  const virtualizer = useVirtualizer({
    count: displayEntries.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize,
    overscan: 15,
  });

  const onEntryClick = useCallback((entry: FileEntry, e: React.MouseEvent) => {
    const idx = filteredEntries.findIndex((fe) => fe.path === entry.path);
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
        return next;
      });
      if (idx >= 0) setFocusedIndex(idx);
    } else if (e.shiftKey && focusedIndex >= 0 && idx >= 0) {
      // Range selection between focusedIndex and clicked index
      const lo = Math.min(focusedIndex, idx);
      const hi = Math.max(focusedIndex, idx);
      setSelected(new Set(filteredEntries.slice(lo, hi + 1).map((fe) => fe.path)));
    } else {
      setSelected(new Set([entry.path]));
      if (idx >= 0) setFocusedIndex(idx);
      if (!entry.isDir) onSelectFile?.(entry.path);
      else onSelectFile?.(null);
    }
  }, [filteredEntries, focusedIndex, onSelectFile]);

  // プロジェクトタスクを持つマニフェストにフォーカスが当たったことを知らせる
  // （LayoutRoot がタスクパネルを開く）。フォーカスはクリックだけでなく矢印キーでも
  // 動くため、プレビュー用の onSelectFile とは別に見る。
  //
  // 「選択されている」ことを条件にするのは、フォルダを開いた直後の focusedIndex=0
  // （ユーザーが触っていない既定位置）で勝手に開かないようにするため。移動時は
  // navResetRef が選択を空にする。
  const notifiedManifestRef = useRef<string | null>(null);
  useEffect(() => {
    const focused = filteredEntries[focusedIndex];
    const path =
      focused && !focused.isDir && selected.has(focused.path) && isProjectManifestFile(focused.name)
        ? focused.path
        : null;
    if (path === notifiedManifestRef.current) return;
    notifiedManifestRef.current = path;
    if (!path) return;
    window.dispatchEvent(
      new CustomEvent(APP_EVENTS.MANIFEST_FOCUSED, { detail: { path } })
    );
  }, [filteredEntries, focusedIndex, selected]);

  const ARCHIVE_EXTS = new Set(["zip", "tar.gz", "tgz"]);
  const isArchive = (entry: FileEntry) =>
    !entry.isDir && (
      ARCHIVE_EXTS.has(entry.extension?.toLowerCase() ?? "") ||
      entry.name.toLowerCase().endsWith(".tar.gz")
    );

  const onEntryDoubleClick = useCallback((entry: FileEntry) => {
    const ext = (entry.extension ?? "").toLowerCase();
    if (entry.isDir) {
      navigateUser(entry.path);
    } else if (isMtpPath(entry.path)) {
      // MTP 上のファイルは実体へ直接アクセスできないため、ローカルへ
      // ダウンロードして取得する（保存先はダイアログで選択）。
      downloadMtpEntry(entry);
    } else if (fileAssociations[ext]) {
      // 拡張子にアプリの関連付けが指定されていれば、内蔵ビューア（アーカイブ・
      // 画像・テキスト）より優先して、指定アプリで自動的に開く。
      // 起動失敗は「何も起きない」ように見えるため、必ずトーストで知らせる。
      invoke("open_with_app", { filePath: entry.path, appPath: fileAssociations[ext] }).catch((e) => {
        showToast(t("fileList.openWithAppFailed", { error: String(e) }));
      });
    } else if (isArchive(entry)) {
      setArchiveBrowserPath(entry.path);
    } else if (IMAGE_EXTS.has(ext)) {
      const siblings = filteredEntries
        .filter((e) => !e.isDir && IMAGE_EXTS.has((e.extension ?? "").toLowerCase()))
        .map((e) => e.path);
      setImageViewer({ path: entry.path, siblings });
    } else if (ext === "md") {
      // md は既定でメインウィンドウから独立したビューアウィンドウで開く
      // （自由に移動・リサイズしながらファイル操作を続けられるようにする）
      openMarkdownViewerWindow(entry.path).catch(console.error);
    } else if (isTextViewable(entry.name, entry.extension, previewExtConfig)) {
      // テキスト系は画像と同様にビューアウィンドウで開く（OS 既定アプリで
      // 開きたい場合はコンテキストメニューの「デフォルトアプリで開く」を使う）。
      setQuickPreviewPath(entry.path);
    } else {
      // 拡張子が未知でも、内容がテキストと判定できればプレビューで表示する
      // （プレビューできない形式をできるだけ減らす）。バイナリと判定された
      // 場合のみ従来どおり OS 既定アプリで開く。
      invoke<{ isText: boolean }>("read_text_file_sniffed", { path: entry.path, maxBytes: 8192 })
        .then((r) => {
          if (r.isText) setQuickPreviewPath(entry.path);
          else openWithDefaultApp(entry.path).catch(console.error);
        })
        .catch(() => openWithDefaultApp(entry.path).catch(console.error));
    }
  }, [navigateUser, filteredEntries, fileAssociations, previewExtConfig, setQuickPreviewPath]);

  const startRename = useCallback((entry: FileEntry) => {
    if (isMtpPath(entry.path)) {
      showToast(t("mtp.renameNotSupported"));
      return;
    }
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
  }, [t]);

  const commitRename = async () => {
    if (isCommittingRenameRef.current) return;
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    isCommittingRenameRef.current = true;
    try {
      const oldPath = renamingPath;
      const dir = oldPath.replace(/[\\/][^\\/]+$/, "");
      // 区切りは元のパスに合わせる（Windows で "C:\dir/new.txt" のような
      // 混在パスになると、タグ等の付け替えや Undo の照合に失敗するため）。
      const sep = oldPath.includes("\\") ? "\\" : "/";
      const newPath = `${dir}${sep}${renameValue.trim()}`;
      await invoke("rename_item", { src: renamingPath, newName: renameValue.trim() });
      // タグ・カラーラベルをリネーム先へ付け替える（フォルダなら配下も）
      followPathChange(oldPath, newPath);
      pushUndo({ type: "rename", oldPath, newPath });
      await navigate(currentPath);
    } catch (e) {
      console.error("[rename_item]", e);
      setError(t("fileList.failedRename"));
    } finally {
      setRenamingPath(null);
      isCommittingRenameRef.current = false;
    }
  };

  const handleDelete = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    // 端末（MTP）は取り出し専用。ここで止めないと確認ダイアログまで出したうえで
    // Rust 側に弾かれ、消えたのか消えていないのか分からない終わり方になる。
    if (paths.some(isMtpPath)) {
      showToast(t("mtp.deleteNotSupported"));
      return;
    }
    const names = paths.map((p) => p.split(/[\\/]/).pop()).join(", ");
    const choice = window.confirm(
      t("fileList.confirmTrash", { names })
    );
    if (!choice) return;
    enqueue(
      paths.map((p) => ({ op: { type: "delete" as const, path: p, trash: true }, label: p.split(/[\\/]/).pop() ?? p })),
      t("fileList.queueTrash", { count: paths.length })
    );
  }, [enqueue]);

  const handleDeletePermanent = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    if (paths.some(isMtpPath)) {
      showToast(t("mtp.deleteNotSupported"));
      return;
    }
    const names = paths.map((p) => p.split(/[\\/]/).pop()).join(", ");
    if (!window.confirm(t("fileList.confirmPermanentDelete", { names }))) return;
    enqueue(
      paths.map((p) => ({ op: { type: "delete" as const, path: p, trash: false }, label: p.split(/[\\/]/).pop() ?? p })),
      t("fileList.queueDelete", { count: paths.length })
    );
  }, [enqueue]);

  // Generate a unique name by appending (2), (3), ... suffix
  // 候補ごとの存在確認は Rust 側でまとめて行う（1 件ずつ IPC を往復すると
  // 同名ファイルが多い場合に貼り付け開始まで待たされる）。
  const generateUniqueName = useCallback(async (path: string): Promise<string> => {
    return invoke<string>("unique_dest_path", { path });
  }, []);

  // 複数パスの存在確認を 1 回の呼び出しにまとめる（貼り付け前の衝突チェック用）。
  const findConflicts = useCallback(
    async (ops: Array<{ src: string; dest: string }>): Promise<Array<{ src: string; dest: string }>> => {
      if (ops.length === 0) return [];
      const exists = await invoke<boolean[]>("paths_exist", { paths: ops.map((o) => o.dest) });
      return ops.filter((_, i) => exists[i]);
    },
    []
  );

  const handleCopy = useCallback((paths: string[]) => {
    setClipboard({ paths, mode: "copy" });
    if (paths.some(isMtpPath)) {
      // mtp:// は端末内の仮想パスで、他アプリからは開けないので OS クリップ
      // ボードには載せない。代わりに以前のファイルリストを消しておく。残したまま
      // だと貼り付け時にそちらが優先され、コピーしたつもりのない物が貼られる。
      invoke("clipboard_clear_file_list").catch(() => {});
      return;
    }
    // エクスプローラー等の他アプリでも貼り付けられるよう OS クリップボードにも書き込む（対応 OS のみ）
    invoke("clipboard_set_file_list", { paths, cut: false }).catch(() => {});
  }, []);
  const handleCut = useCallback((paths: string[]) => {
    // 端末（MTP）上のファイルは削除・移動に対応していないため切り取れない。
    // コピーなら「取り出し」として貼り付けられる。
    if (paths.some(isMtpPath)) {
      showToast(t("mtp.cutNotSupported"));
      return;
    }
    setClipboard({ paths, mode: "cut" });
    invoke("clipboard_set_file_list", { paths, cut: true }).catch(() => {});
  }, [t]);

  // MTP（スマホ等）からの取り出しを操作キューに積む。取り出し先に同名ファイルが
  // ある場合は通常のコピー/移動と同じ一括ダイアログで解決する（黙って上書きしない）。
  // 戻り値 false はユーザーがキャンセルしたことを表し、呼び出し側も中断する。
  const enqueueMtpDownloads = useCallback(async (
    downloads: Array<{ src: string; dest: string }>,
    destDirRaw: string
  ): Promise<boolean> => {
    if (downloads.length === 0) return true;
    const conflicts = await findConflicts(downloads);
    let resolution: ConflictResolution = "overwrite";
    if (conflicts.length > 0) {
      resolution = await new Promise<ConflictResolution>((resolve) => {
        setConflictInfo({ files: conflicts, resolve });
      });
      setConflictInfo(null);
      if (resolution === "cancel") return false;
    }
    const ops: Array<{ src: string; dest: string; overwrite: boolean }> = [];
    for (const d of downloads) {
      const isConflict = conflicts.some((c) => c.src === d.src);
      if (isConflict && resolution === "skip") continue;
      const dest = isConflict && resolution === "rename"
        ? await generateUniqueName(d.dest)
        : d.dest;
      // 上書きは利用者が明示的に選んだときだけ許す。既存ファイルの衝突は
      // findConflicts が拾うが、それはディスク上の既存だけを見ており、
      // 同じ一括処理の中で宛先が重なる場合（大文字小文字だけが異なる名前が
      // 同じフォルダに並ぶ端末。Windows 側は区別しないため同じ取り出し先に
      // なる）は拾えない。許可制にしておけば、2件目は黙って上書きせず
      // 失敗として残る。
      ops.push({ src: d.src, dest, overwrite: isConflict && resolution === "overwrite" });
    }
    if (ops.length > 0) {
      enqueue(
        ops.map(({ src, dest, overwrite }) => ({
          op: { type: "mtpDownload" as const, src, dest, overwrite },
          label: src.split(/[\\/]/).pop() ?? src,
        })),
        t("mtp.queueDownload", {
          count: ops.length,
          dest: destDirRaw.split(/[\\/]/).filter(Boolean).pop() || destDirRaw,
        })
      );
    }
    return true;
  }, [findConflicts, generateUniqueName, enqueue, t]);

  const handlePaste = useCallback(async () => {
    // OS クリップボード（エクスプローラー等でコピー/カットしたファイル）を優先する。
    // アプリ内のコピー/カットも OS クリップボードへ書き込むため、対応 OS では
    // OS クリップボードが常に「最後にコピーしたもの」を表す。非対応 OS では
    // null が返り、アプリ内クリップボードにフォールバックする。
    let source = clipboard;
    let fromOs = false;
    // ただしアプリ内クリップボードが端末（MTP）上のファイルなら OS 側は見ない。
    // mtp:// は OS クリップボードに載せられないため、載っているのは以前の別の
    // コピーであり、優先すると意図しない物が貼られる。
    if (!clipboard?.paths.some(isMtpPath)) {
      try {
        const os = await invoke<{ paths: string[]; cut: boolean } | null>("clipboard_get_file_list");
        if (os && os.paths.length > 0) {
          source = { paths: os.paths, mode: os.cut ? "cut" : "copy" };
          fromOs = true;
        }
      } catch { /* ignore */ }
    }
    if (!source) return;

    // 端末（MTP）が絡む貼り付けは通常のファイル操作として扱えない。
    //  - MTP → ローカル: コピー/移動ではなく「取り出し（ダウンロード）」
    //  - ローカル → MTP / MTP → MTP: 書き込み非対応
    // ここで振り分けないと mtp:// の仮想パスが copy_item/move_item に渡り、
    // 「絶対パスを指定してください」で失敗する。
    const mtpPlan = planMtpTransfer(source.paths, currentPath);
    if (mtpPlan.unsupported) {
      showToast(t("mtp.writeNotSupported"));
      return;
    }
    if (mtpPlan.downloads.length > 0) {
      // 端末側からは削除できないので、切り取りで来ても取り出し（コピー）にする。
      if (source.mode === "cut") showToast(t("mtp.cutFallsBackToCopy"));
      if (!(await enqueueMtpDownloads(mtpPlan.downloads, currentPath))) return;
    }
    // MTP 以外が混ざっていた場合は通常のコピー/移動として続行する。
    const srcPaths = mtpPlan.remaining;
    if (srcPaths.length === 0) return;

    const sep = currentPath.includes("\\") ? "\\" : "/";
    // ドライブルート等、currentPath が区切り文字で終わる場合の二重区切りを防ぐ
    const destDir = currentPath.endsWith(sep) ? currentPath.slice(0, -1) : currentPath;
    // コピー元と同じフォルダへの貼り付け: コピーならエクスプローラー同様
    // 「name (2)」の複製を作る。カットは自分自身への移動になるため何もしない。
    const ops: Array<{ src: string; dest: string }> = [];
    for (const src of srcPaths) {
      const dest = `${destDir}${sep}${src.split(/[\\/]/).pop()!}`;
      if (src !== dest) {
        ops.push({ src, dest });
      } else if (source.mode === "copy") {
        ops.push({ src, dest: await generateUniqueName(dest) });
      }
    }

    // Detect conflicts（存在確認は 1 回の呼び出しでまとめて行う）
    const conflicts = await findConflicts(ops);

    let resolution: ConflictResolution = "overwrite";
    if (conflicts.length > 0) {
      resolution = await new Promise<ConflictResolution>((resolve) => {
        setConflictInfo({ files: conflicts, resolve });
      });
      setConflictInfo(null);
      if (resolution === "cancel") return;
    }

    const resolvedOps: Array<{ src: string; dest: string }> = [];
    for (const op of ops) {
      const isConflict = conflicts.some((c) => c.src === op.src);
      let dest = op.dest;
      if (isConflict) {
        if (resolution === "skip") continue;
        if (resolution === "rename") dest = await generateUniqueName(op.dest);
      }
      resolvedOps.push({ src: op.src, dest });
    }

    if (resolvedOps.length === 0) return;
    const mode = source.mode;
    const groupLabel = mode === "copy"
      ? t("fileList.queueCopy", { count: resolvedOps.length, dest: currentPath.split(/[\\/]/).pop() ?? currentPath })
      : t("fileList.queueMove", { count: resolvedOps.length, dest: currentPath.split(/[\\/]/).pop() ?? currentPath });

    enqueue(
      resolvedOps.map(({ src, dest }) => ({
        op: mode === "copy"
          ? { type: "copy" as const, src, dest, overwrite: resolution === "overwrite" }
          : { type: "move" as const, src, dest, overwrite: resolution === "overwrite" },
        label: src.split(/[\\/]/).pop() ?? src,
      })),
      groupLabel
    );

    if (mode === "cut") {
      const originalDir = resolvedOps[0].src.replace(/[\\/][^\\/]+$/, "");
      pushUndo({ type: "move", srcPaths: resolvedOps.map((o) => o.src), destDir: currentPath, originalDir });
      setClipboard(null);
      // 切り取りの貼り付け後はエクスプローラー同様 OS クリップボードも空にする
      if (fromOs) invoke("clipboard_clear_file_list").catch(() => {});
    }
  }, [clipboard, currentPath, generateUniqueName, findConflicts, pushUndo, enqueue, enqueueMtpDownloads, t]);

  // Load custom context menu items on mount
  useEffect(() => {
    invoke<CustomMenuItem[]>("load_context_menu_config")
      .then(setCustomMenuItems)
      .catch(console.error);
  }, [showMenuEditor]); // reload after editor closes

  const runCustomCommand = useCallback(async (template: string, paths: string[], entry: FileEntry) => {
    const sep = currentPath.includes("\\") ? "\\" : "/";
    const dir = entry.isDir ? entry.path : entry.path.split(/[\\/]/).slice(0, -1).join(sep) || currentPath;
    const quotePath = (p: string) => `"${p}"`;
    const command = template
      .replace(/{paths}/g, paths.map(quotePath).join(" "))
      .replace(/{path}/g, quotePath(entry.path))
      .replace(/{dir}/g, quotePath(dir))
      .replace(/{name}/g, entry.name);
    try {
      await invoke("run_user_command", { command, cwd: dir });
    } catch (e) {
      console.error("[run_user_command]", e);
      setError(t("fileList.commandFailed", { error: e }));
    }
  }, [currentPath]);


  const handleCompress = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    // mtp:// は通常のファイルシステムに無いため、圧縮側では黙って捨てられて
    // 中身ゼロのアーカイブができていた（Rust 側でも弾くが、ここで理由を出す）。
    if (paths.some(isMtpPath)) {
      showToast(t("mtp.compressNotSupported"));
      return;
    }
    setCompressTargets(paths);
  }, [t]);

  // OS クリップボードにファイルが載っているか（メニューの「貼り付け」活性判定用）。
  // メニューを開くたびに非同期で確認して state を更新する。
  const refreshOsClipboardState = useCallback(() => {
    invoke<{ paths: string[]; cut: boolean } | null>("clipboard_get_file_list")
      .then((r) => setOsClipboardHasFiles(!!r && r.paths.length > 0))
      .catch(() => setOsClipboardHasFiles(false));
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    const paths = selected.has(entry.path)
      ? Array.from(selected)
      : [entry.path];
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      const idx = filteredEntries.findIndex((fe) => fe.path === entry.path);
      if (idx >= 0) setFocusedIndex(idx);
    }
    refreshOsClipboardState();
    setContextMenu({ x: e.clientX, y: e.clientY, screenX: e.screenX, screenY: e.screenY, entry, paths });
  }, [selected, filteredEntries, refreshOsClipboardState]);

  // ファイル一覧の空白部分の右クリックメニュー。行やヘッダのハンドラが
  // preventDefault 済みのイベントは対象外（バブリングで届いても無視する）。
  const handleBgContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    refreshOsClipboardState();
    setBgMenu({ x: e.clientX, y: e.clientY });
  }, [refreshOsClipboardState]);

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
  }, []);

  const handleRefresh = useCallback(() => {
    navigate(currentPath);
  }, [currentPath, navigate]);

  const handleShowProperties = useCallback((entry: FileEntry) => {
    setPropertiesPath(entry.path);
  }, []);

  const handleCopyPath = useCallback((paths: string[]) => {
    navigator.clipboard.writeText(paths.join("\n")).catch(console.error);
  }, []);

  const handleRevealInExplorer = useCallback((path: string) => {
    revealItemInDir(path).catch(console.error);
  }, []);

  const calculateDirSizes = useCallback(async (dirs: FileEntry[]) => {
    if (dirs.length === 0) return;
    // 前回の計算が残っていれば先に止める（同じトークンで新しい走査を始めるため、
    // 登録より先にキャンセルを完了させる）。
    await cancelDirSizeScans();
    const seq = scanSeqRef.current;
    const token = scanTokenRef.current;
    setShowDirSizes(true);
    setDirSizes((prev) => {
      const next = new Map(prev);
      for (const d of dirs) next.set(d.path, "loading");
      return next;
    });
    await Promise.all(dirs.map(async (d) => {
      try {
        const size = await invoke<number>("get_dir_size", { path: d.path, scanToken: token });
        // 中断済み（別パスへ移動した）の結果は捨てる
        if (scanSeqRef.current !== seq) return;
        setDirSizes((prev) => new Map(prev).set(d.path, size));
      } catch {
        if (scanSeqRef.current !== seq) return;
        setDirSizes((prev) => { const m = new Map(prev); m.delete(d.path); return m; });
      }
    }));
  }, [cancelDirSizeScans]);

  const handleQuickJump = useCallback((char: string) => {
    // Accumulate characters, reset after 600ms idle
    if (quickJumpTimerRef.current) clearTimeout(quickJumpTimerRef.current);
    quickJumpBufferRef.current += char.toLowerCase();
    quickJumpTimerRef.current = setTimeout(() => { quickJumpBufferRef.current = ""; }, 600);

    const buf = quickJumpBufferRef.current;
    // Find first entry whose name starts with buffer (case-insensitive)
    let idx = filteredEntries.findIndex((e) => e.name.toLowerCase().startsWith(buf));
    // If no match for full buffer, fall back to single char starting from next position
    if (idx === -1 && buf.length > 1) {
      const single = buf[buf.length - 1];
      idx = filteredEntries.findIndex((e) => e.name.toLowerCase().startsWith(single));
      if (idx !== -1) quickJumpBufferRef.current = single;
    }
    if (idx === -1) return;
    setFocusedIndex(idx);
    setSelected(new Set([filteredEntries[idx].path]));
    // Scroll virtual list to reveal the item
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [filteredEntries, setFocusedIndex, setSelected, virtualizer]);

  const { handleKeyDown } = useFileListShortcuts({
    entries: filteredEntries,
    focusedIndex,
    setFocusedIndex,
    selected,
    setSelected,
    onOpen: (entry) => { if (entry.isDir) navigateUser(entry.path); },
    onNavigateUp: navigateUp,
    onRename: startRename,
    onDelete: handleDelete,
    onCopy: handleCopy,
    onCut: handleCut,
    onPaste: handlePaste,
    onFocusSearch: focusSearch,
    onRefresh: handleRefresh,
    onShowProperties: handleShowProperties,
    onCopyPath: handleCopyPath,
    onRevealInExplorer: handleRevealInExplorer,
    onAddBookmark: () => {
      // Bookmark the focused folder if one is focused, otherwise the current directory.
      const focused = filteredEntries[focusedIndex];
      const target = focused?.isDir ? focused.path : currentPath;
      addBookmark(target).catch((e) => console.error("[addBookmark]", e));
    },
    onQuickJump: handleQuickJump,
    onCopyToOtherPane: compareEnabled ? async (paths) => {
      const otherEntries = Array.from(paneEntries.entries()).find(([id]) => id !== paneId)?.[1];
      if (!otherEntries || otherEntries.length === 0) return;
      const destDir = otherEntries[0].path.replace(/[\\/][^\\/]+$/, "");
      // 端末（MTP）が絡む場合は copy_item ではなく取り出しコマンドへ振り分ける。
      // 貼り付け・D&D と同じ理由で、mtp:// は通常のファイルパスとして扱えない。
      const mtpPlan = planMtpTransfer(paths, destDir);
      if (mtpPlan.unsupported) {
        showToast(t("mtp.writeNotSupported"));
        return;
      }
      if (mtpPlan.downloads.length > 0) {
        if (!(await enqueueMtpDownloads(mtpPlan.downloads, destDir))) return;
        paths = mtpPlan.remaining;
        if (paths.length === 0) return;
      }
      const destPaths = paths.map((src) => `${destDir}/${src.split(/[\\/]/).pop()!}`);
      const existsList = await invoke<boolean[]>("paths_exist", { paths: destPaths });
      const resolvedOps: Array<{ src: string; dest: string; overwrite: boolean }> = [];
      for (const [i, src] of paths.entries()) {
        const dest = destPaths[i];
        if (existsList[i]) {
          const resolution = await new Promise<ConflictResolution>((resolve) => setConflictInfo({ files: [{ src, dest }], resolve }));
          setConflictInfo(null);
          if (resolution === "cancel") return;
          if (resolution === "skip") continue;
          if (resolution === "rename") {
            const unique = await generateUniqueName(dest);
            resolvedOps.push({ src, dest: unique, overwrite: false });
            continue;
          }
        }
        resolvedOps.push({ src, dest, overwrite: true });
      }
      if (resolvedOps.length > 0) {
        enqueue(
          resolvedOps.map(({ src, dest, overwrite }) => ({ op: { type: "copy" as const, src, dest, overwrite }, label: src.split(/[\\/]/).pop() ?? src })),
          t("fileList.queueCopy", { count: resolvedOps.length, dest: destDir.split(/[\\/]/).pop() ?? destDir })
        );
      }
    } : undefined,
    onMoveToOtherPane: compareEnabled ? async (paths) => {
      const otherEntries = Array.from(paneEntries.entries()).find(([id]) => id !== paneId)?.[1];
      if (!otherEntries || otherEntries.length === 0) return;
      const destDir = otherEntries[0].path.replace(/[\\/][^\\/]+$/, "");
      // 端末（MTP）は書き込みも端末側の削除も非対応なので、移動は成立しない。
      // 取り出し（コピー）で受け取るよう促す。
      const mtpPlan = planMtpTransfer(paths, destDir);
      if (mtpPlan.unsupported || mtpPlan.downloads.length > 0) {
        showToast(t(mtpPlan.unsupported ? "mtp.writeNotSupported" : "mtp.cutNotSupported"));
        if (mtpPlan.remaining.length === 0) return;
        paths = mtpPlan.remaining;
      }
      const destPaths = paths.map((src) => `${destDir}/${src.split(/[\\/]/).pop()!}`);
      const existsList = await invoke<boolean[]>("paths_exist", { paths: destPaths });
      const resolvedOps = paths.map((src, i) => ({ src, dest: destPaths[i], overwrite: existsList[i] }));
      if (resolvedOps.length > 0) {
        enqueue(
          resolvedOps.map(({ src, dest, overwrite }) => ({ op: { type: "move" as const, src, dest, overwrite }, label: src.split(/[\\/]/).pop() ?? src })),
          t("fileList.queueMove", { count: resolvedOps.length, dest: destDir.split(/[\\/]/).pop() ?? destDir })
        );
      }
    } : undefined,
  });

  // ドラッグ対象が選択に含まれていれば選択全体を、含まれていなければその 1 件
  // だけを移動対象にする（Explorer 同様）。コールバックの identity を安定させ
  // FileRow の memo を壊さないよう、selected は ref 経由で読む。
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const onDragStart = useCallback((e: React.DragEvent, entry: FileEntry) => {
    const sel = selectedRef.current;
    const srcPaths = sel.has(entry.path) && sel.size > 1 ? [...sel] : [entry.path];
    const payload = { srcPath: entry.path, srcPaths, srcPaneId: paneId };

    // 実アプリでは HTML5 のドラッグを止めて OS のドラッグに差し替える。
    // これでエクスプローラー等の他アプリへ落とせる（CF_HDROP のコピー）。
    // アプリ内のドロップは WebView が発火する dragover / drop と控え（active）で
    // 従来どおり成立する。ブラウザのデモ・E2E・仮想パス（mtp:// 等）では false が
    // 返り、下の HTML5 ドラッグのまま進む。
    if (beginNativeFileDrag(e, payload, entry.name)) return;

    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(payload));
    // move: フォルダへのドロップ移動 / copy: ターミナルへのパス貼り付け
    e.dataTransfer.effectAllowed = "copyMove";
    // 既定のドラッグ画像は「掴んだ行のスクリーンショット」で、一覧幅の四角い枠が
    // 付いてくる。種別アイコン＋名前の小さなカードに差し替える。
    applyFileDragImage(e.dataTransfer, entry, srcPaths.length, iconSet);

    // 掴んでいる内容を控える。dataTransfer が読めない文脈でもアプリ内の
    // ドロップ処理がこちらを読めるようにする。
    setActiveDrag(payload);
  }, [paneId, iconSet]);

  const onDragEnd = useCallback(() => {
    setDragOverDir(null);
    clearActiveDrag();
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, dirPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    // ネイティブドラッグは copy のみ許可で開始しているため "move" を返すと
    // drop が発火しない。ヘルパでドラッグの種類に合う効果を選ぶ。
    e.dataTransfer.dropEffect = internalDropEffect(e.dataTransfer);
    setDragOverDir(dirPath);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverDir(null);
    }
  }, []);

  // D&D 移動の共通処理: srcPaths を dropDir へ移動キューに積む。
  // フォルダを自分自身・自身の配下へ落とす誤操作と、同じフォルダ内への
  // ドロップ（移動なし）は除外。衝突は貼り付けと同じ一括ダイアログで解決。
  const dropMove = useCallback(async (srcPaths: string[], dropDirRaw: string) => {
    try {
      // MTP（スマホ等）が絡むドロップは通常のファイル移動として扱えない。
      // - MTP → ローカル: 移動ではなく「取り出し（ダウンロード）」
      // - ローカル → MTP / MTP → MTP: 書き込み非対応
      // ここで振り分けないと mtp:// の仮想パスが move_item に渡り、
      // 「絶対パスを指定してください」で失敗する。
      const plan = planMtpTransfer(srcPaths, dropDirRaw);
      if (plan.unsupported) {
        showToast(t("mtp.writeNotSupported"));
        return;
      }
      if (plan.downloads.length > 0) {
        if (!(await enqueueMtpDownloads(plan.downloads, dropDirRaw))) return;
        // MTP 以外が混ざっていた場合は通常の移動として続行する
        srcPaths = plan.remaining;
        if (srcPaths.length === 0) return;
      }
      const sep = dropDirRaw.includes("\\") ? "\\" : "/";
      // 比較用に末尾区切りを除去（ドライブルート "/" や "C:\" はそのまま連結側で処理）
      const dropDir =
        dropDirRaw.length > 1 && dropDirRaw.endsWith(sep) ? dropDirRaw.slice(0, -1) : dropDirRaw;
      const joinDest = (name: string) =>
        dropDir.endsWith(sep) ? `${dropDir}${name}` : `${dropDir}${sep}${name}`;
      const ops: Array<{ src: string; dest: string }> = [];
      for (const src of srcPaths) {
        if (src === dropDir || dropDir.startsWith(src + sep)) continue;
        const dest = joinDest(src.split(/[\\/]/).pop()!);
        if (dest === src) continue;
        ops.push({ src, dest });
      }
      if (ops.length === 0) return;

      const conflicts = await findConflicts(ops);
      let resolution: ConflictResolution = "overwrite";
      if (conflicts.length > 0) {
        resolution = await new Promise<ConflictResolution>((resolve) => {
          setConflictInfo({ files: conflicts, resolve });
        });
        setConflictInfo(null);
        if (resolution === "cancel") return;
      }

      const resolvedOps: Array<{ src: string; dest: string; overwrite: boolean }> = [];
      for (const op of ops) {
        const isConflict = conflicts.some((c) => c.src === op.src);
        let dest = op.dest;
        if (isConflict) {
          if (resolution === "skip") continue;
          if (resolution === "rename") dest = await generateUniqueName(op.dest);
        }
        resolvedOps.push({ src: op.src, dest, overwrite: isConflict && resolution === "overwrite" });
      }
      if (resolvedOps.length === 0) return;

      enqueue(
        resolvedOps.map(({ src, dest, overwrite }) => ({
          op: { type: "move" as const, src, dest, overwrite },
          label: src.split(/[\\/]/).pop() ?? src,
        })),
        t("fileList.queueMoveTo", { dest: dropDir.split(/[\\/]/).pop() || dropDir })
      );

      // 全件が同じ親フォルダからの移動なら Undo（元の場所へ戻す）を積む。
      // 再帰検索結果など出所が混在する場合は戻し先が一意でないため積まない。
      const parents = new Set(resolvedOps.map((o) => o.src.replace(/[\\/][^\\/]+$/, "")));
      if (parents.size === 1) {
        pushUndo({
          type: "move",
          srcPaths: resolvedOps.map((o) => o.src),
          destDir: dropDir,
          originalDir: [...parents][0],
        });
      }
    } catch (e) {
      console.error("[drop move]", e);
      setError(t("fileList.failedMove"));
    }
  }, [enqueue, generateUniqueName, findConflicts, pushUndo, setConflictInfo, setError, enqueueMtpDownloads, t]);

  /** DataTransfer から移動対象パスの一覧を取り出す（無ければ空配列）。
   *  他アプリへ引き出せるよう OS のドラッグに切り替わっている間は
   *  dataTransfer が空になるため、readInternalDrag が控えたほうを返す。 */
  const readDragPaths = (e: React.DragEvent): string[] => {
    return readInternalDrag(e.dataTransfer)?.srcPaths ?? [];
  };

  const onDrop = useCallback(async (e: React.DragEvent, dropDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverDir(null);
    const srcPaths = readDragPaths(e);
    // 別ペインからのドロップも受け付ける（デュアルペイン間の階層移動）。
    if (srcPaths.length > 0) await dropMove(srcPaths, dropDir);
  }, [dropMove]);

  // 一覧の背景（空きスペース・ファイル行）へのドロップ: 現在のフォルダへ移動。
  // 同一フォルダ内のドロップは dropMove 側で除外されるため実質は
  // 「別ペイン・検索結果からこのフォルダへ移す」操作になる。
  const onBgDragOver = useCallback((e: React.DragEvent) => {
    if (isInternalDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = internalDropEffect(e.dataTransfer);
    }
  }, []);

  const onBgDrop = useCallback(async (e: React.DragEvent) => {
    if (!currentPath) return;
    e.preventDefault();
    setDragOverDir(null);
    const srcPaths = readDragPaths(e);
    if (srcPaths.length > 0) await dropMove(srcPaths, currentPath);
  }, [currentPath, dropMove]);

  // 「上の階層へ」ボタンへのドロップ: 親フォルダへ移動（階層を上がる移動）。
  const [dragOverUp, setDragOverUp] = useState(false);
  // 一覧の先頭に置く「上の階層へ」行のドラッグオーバー状態（ツールバーの ↑ とは別管理）
  const [dragOverUpRow, setDragOverUpRow] = useState(false);

  // 親フォルダがあるか（ルートでは行を出さない）。
  // get_parent_dir は非同期なので、描画のたびに IPC せず表示はパスから判断する。
  // 実際の移動は navigateUp / onUpDrop が get_parent_dir の結果で行うため、
  // 判定が甘くても誤って移動することはない。
  const parentDirPath = useMemo(() => {
    if (!currentPath) return null;
    const trimmed = currentPath.replace(/[\\/]+$/, "");
    if (!trimmed) return null;                       // "/" 自体
    if (/^[A-Za-z]:$/.test(trimmed)) return null;    // "C:\" 自体
    const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (idx < 0) return null;
    return idx === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, idx);
  }, [currentPath]);
  const hasParentDir = parentDirPath !== null;
  const parentDirName = parentDirPath
    ? parentDirPath.split(/[\\/]/).filter(Boolean).pop() ?? parentDirPath
    : "";
  const onUpDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverUp(false);
    if (!currentPath) return;
    const srcPaths = readDragPaths(e);
    if (srcPaths.length === 0) return;
    const parent = await invoke<string | null>("get_parent_dir", { path: currentPath });
    if (parent) await dropMove(srcPaths, parent);
  }, [currentPath, dropMove]);

  // Memoize row labels (i18n strings) so the FileRow memo isn't busted by
  // a new labels object every render.
  const rowLabels: RowLabels = useMemo(() => ({
    pinned: t("fileList.pinned"),
    diffChanged: t("fileList.diffChanged"),
    diffThisPaneOnly: t("fileList.diffThisPaneOnly"),
    colorLabel: t("fileList.colorLabel"),
    typeFolder: t("fileList.typeFolder"),
    typeImage: t("fileList.typeImage"),
    typeCode: t("fileList.typeCode"),
    typeText: t("fileList.typeText"),
    typeArchive: t("fileList.typeArchive"),
    typeFile: t("fileList.typeFile"),
  // i18n.language is the right invalidation key when language switches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [i18n.language]);

  const headerCell = (col: SortKey, label: string, extraClass = "") => (
    <button
      className={`flex items-center gap-0.5 text-xs text-left hover:opacity-80 transition-opacity whitespace-nowrap px-1 ${extraClass}`}
      style={{ color: col === sortKey ? "var(--kf-accent)" : "var(--kf-text-muted)" }}
      onClick={() => handleSort(col)}
    >
      {label}
      <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
    </button>
  );

  return (
    <div
      className="flex flex-col w-full h-full min-w-0 overflow-hidden text-sm relative"
      style={{ backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-primary)" }}
      data-testid="file-list"
      tabIndex={0}
      onMouseDown={(e) => {
        // Mouse button 3 (back) / 4 (forward)
        if (e.button === 3) { e.preventDefault(); goBack(); }
        else if (e.button === 4) { e.preventDefault(); goForward(); }
      }}
      onKeyDown={(e) => {
        // 編集要素（検索・パス・リネーム等の入力）にフォーカスがあるときは、
        // ファイル用ショートカットを発火させずブラウザ標準の入力操作に委ねる
        // （Ctrl+A 全選択・Space 入力・"+"/"-" 入力・Ctrl+N など）。
        {
          const tgt = e.target as HTMLElement;
          if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable) return;
        }
        // Esc → 読み込み中のディレクトリ移動を中断して直前の一覧に戻る。
        // ネットワークボリュームやスリープ中の外付けディスクでは read_dir が
        // 数十秒返らないことがあり、その間ペインがスケルトンのまま固まって見える。
        if (e.key === "Escape" && loading && currentPath) {
          e.preventDefault();
          cancelNavigation();
          void cancelDirSizeScans();
          return;
        }
        // Ctrl + "+" / "-" → 表示形式を一段ずつ（詳細 → 一覧 → サムネイル小 → 大）。
        // テンキーの "+"/"-" と、Shift 無しで "=" が来る配列（US 等）も拾う。
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          if (e.key === "+" || e.key === ";" || e.key === "=" || e.key === "Add") {
            e.preventDefault();
            stepViewMode(1);
            return;
          }
          if (e.key === "-" || e.key === "_" || e.key === "Subtract") {
            e.preventDefault();
            stepViewMode(-1);
            return;
          }
        }
        // Alt+Left → 戻る
        if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBack(); return; }
        // Alt+Right → 進む
        if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goForward(); return; }
        // Ctrl+Shift+N → 新規フォルダ
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
          e.preventDefault();
          setCreatingName(t("fileList.newFolder"));
          setCreatingType("dir");
          return;
        }
        // Ctrl+N → 新規ファイル
        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "n") {
          e.preventDefault();
          setCreatingName(`${t("fileList.newFolder")}.txt`);
          setCreatingType("file");
          return;
        }
        // Ctrl+A → 全選択
        if (e.ctrlKey && e.key.toLowerCase() === "a") {
          e.preventDefault();
          setSelected(new Set(filteredEntries.map((fe) => fe.path)));
          return;
        }
        // Space → クイックプレビューのトグル（Finder 同様）
        if (e.key === " " && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          const focused = filteredEntries[focusedIndex];
          if (quickPreviewPath || (focused && !focused.isDir)) {
            e.preventDefault();
            // stopPropagation が無いと、この keydown が window まで伝播し、
            // マウント直後の QuickPreviewModal の「Space で閉じる」ハンドラが
            // 同一イベントで発火して開いた瞬間に閉じてしまう。
            // 表示中はフォーカスがリスト側に残るため、閉じる方向も
            // ここでトグルとして扱う。
            e.stopPropagation();
            if (!quickPreviewPath && isMtpPath(focused!.path)) {
              // 端末上のファイルは実体へ直接アクセスできないため読めない。
              showToast(t("mtp.previewNotSupported"));
              return;
            }
            setQuickPreviewPath(quickPreviewPath ? null : focused!.path);
            return;
          }
        }
        // ⌘L / Ctrl+L → パス入力を開く（ブラウザ・エクスプローラー共通の作法）。
        // 狭いペインでアドレスバーを畳んでいても、ここから必ず到達できる。
        if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) {
          e.preventDefault();
          openPathBar();
          return;
        }
        // + → パターン選択ダイアログ
        if (e.key === "+" && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          setPatternInput("");
          setPatternDialog("add");
          return;
        }
        // - → パターン選択解除ダイアログ
        if (e.key === "-" && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          setPatternInput("");
          setPatternDialog("remove");
          return;
        }
        // Shift+Delete: permanent delete (bypasses trash)
        if (e.key === "Delete" && e.shiftKey && selected.size > 0) {
          e.preventDefault();
          handleDeletePermanent(Array.from(selected));
          return;
        }
        handleKeyDown(e);
      }}
      ref={listContainerRef}
    >
      {/* アドレスバー。極端に狭いペインでは畳む。
          - 現在地: タブのタイトル（ツールチップにフルパス）とウィンドウタイトル
          - 階層移動: 一覧先頭の「..」行 / Backspace / マウスの戻る・進む
          - パス入力: ⌘L（Ctrl+L）で一時的に開く
          いずれも代替があるうえで畳んでいる。 */}
      {(density !== "minimal" || pathBarOpen) && (
      <div
        className="flex items-center gap-1 px-2 py-1 border-b shrink-0"
        style={{
          backgroundColor: "var(--kf-bg-secondary)",
          borderColor: "var(--kf-border)",
        }}
      >
        <button
          onClick={goBack}
          disabled={!canGoBack}
          className="px-1 py-0.5 rounded transition-colors flex items-center disabled:opacity-20"
          style={{ color: "var(--kf-text-muted)" }}
          title={t("fileList.goBack")}
        >
          <Icon name="arrow_back" size={14} />
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          className="px-1 py-0.5 rounded transition-colors flex items-center disabled:opacity-20"
          style={{ color: "var(--kf-text-muted)" }}
          title={t("fileList.goForward")}
        >
          <Icon name="arrow_forward" size={14} />
        </button>
        <button
          onClick={navigateUp}
          className="px-1 py-0.5 rounded transition-colors flex items-center"
          style={{
            color: dragOverUp ? "var(--kf-accent)" : "var(--kf-text-muted)",
            backgroundColor: dragOverUp
              ? "color-mix(in srgb, var(--kf-accent) 22%, transparent)"
              : undefined,
          }}
          title={t("fileList.goParent")}
          // ファイル/フォルダをドロップすると親フォルダへ移動（階層を上がる）
          onDragOver={(e) => {
            if (currentPath && isInternalDrag(e.dataTransfer)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = internalDropEffect(e.dataTransfer);
              setDragOverUp(true);
            }
          }}
          onDragLeave={() => setDragOverUp(false)}
          onDrop={onUpDrop}
        >
          <Icon name="arrow_upward" size={14} />
        </button>
        {/* ドライブ一覧ボタン（currentPathがあるときのみ表示） */}
        {currentPath && (
          <button
            onClick={() => navigateUser("")}
            className="px-1 py-0.5 rounded transition-colors flex items-center"
            style={{ color: "var(--kf-text-muted)" }}
            title={t("fileList.goHome")}
          >
            <Icon name="grid_view" size={14} />
          </button>
        )}
        {/* ホームボタン */}
        <div className="relative">
          <button
            onClick={() => { if (homePath) navigateUser(homePath); }}
            onContextMenu={(e) => {
              e.preventDefault();
              setShowHomeMenu({ x: e.clientX, y: e.clientY });
            }}
            className="px-1 py-0.5 rounded transition-colors flex items-center"
            style={{ color: "var(--kf-text-muted)" }}
            title={t("fileList.homeTooltip", { path: homePath || t("fileList.notSet") })}
          >
            <Icon name="home" size={14} />
          </button>
          {showHomeMenu && (
            <div
              ref={homeMenuRef}
              className="fixed z-50 rounded shadow-xl py-2 px-3 text-xs"
              style={{
                left: showHomeMenu.x,
                top: showHomeMenu.y,
                backgroundColor: "var(--kf-bg-secondary)",
                border: "1px solid var(--kf-border)",
                color: "var(--kf-text-primary)",
                minWidth: 260,
              }}
            >
              <div className="mb-1.5 font-semibold" style={{ color: "var(--kf-text-secondary)" }}>
                {t("fileList.homePathSettings")}
              </div>
              <input
                type="text"
                defaultValue={homePath}
                autoFocus
                className="w-full rounded px-2 py-1 text-xs outline-none mb-2"
                style={{
                  backgroundColor: "var(--kf-bg-primary)",
                  border: "1px solid var(--kf-border)",
                  color: "var(--kf-text-primary)",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = (e.currentTarget as HTMLInputElement).value.trim();
                    if (v) {
                      setHomePath(v);
                      localStorage.setItem("kf-home-path", v);
                    }
                    setShowHomeMenu(null);
                  }
                  if (e.key === "Escape") setShowHomeMenu(null);
                }}
              />
              <div className="flex gap-1.5">
                <button
                  className="flex-1 px-2 py-1 rounded text-xs hover:opacity-80"
                  style={{ backgroundColor: "var(--kf-bg-tertiary)", border: "1px solid var(--kf-border)" }}
                  onClick={() => {
                    setHomePath(currentPath);
                    localStorage.setItem("kf-home-path", currentPath);
                    setShowHomeMenu(null);
                  }}
                >
                  {t("fileList.setCurrentAsHome")}
                </button>
                <button
                  className="px-2 py-1 rounded text-xs hover:opacity-80"
                  style={{ backgroundColor: "var(--kf-bg-tertiary)", border: "1px solid var(--kf-border)" }}
                  onClick={() => setShowHomeMenu(null)}
                >
                  {t("common.close")}
                </button>
              </div>
            </div>
          )}
        </div>
        <PathAutocomplete
          currentPath={currentPath}
          onNavigate={navigateUser}
          openSignal={pathBarOpenSignal}
          onDeactivate={() => setPathBarOpen(false)}
        />
      </div>
      )}

      {/* 検索バー（右端に新規作成・表示切替などのツール群を並べる） */}
      <FileListSearchBar
        searchInputRef={searchInputRef}
        searchActive={searchActive}
        setSearchActive={setSearchActive}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchMode={searchMode}
        onToggleSearchMode={() => setSearchMode((m) => m === "local" ? "recursive" : m === "recursive" ? "content" : "local")}
        recursiveLoading={recursiveLoading}
        grepLoading={grepLoading}
        onCancelSearch={cancelSearch}
        onCancelGrep={cancelGrepSearch}
        onFocusList={() => listContainerRef.current?.focus()}
      >
        {/* 狭いペインでフィルタ行を畳んでいるときの開閉ボタン。
            畳んでいる間だけ出す（広いときは行そのものが常時見えている）。 */}
        {density === "minimal" && !filterActive && (
          <button
            onClick={() => setFilterRowOpen((v) => !v)}
            className="flex items-center px-1 py-0.5 rounded transition-opacity"
            style={{
              color: filterRowOpen ? "var(--kf-accent)" : "var(--kf-text-muted)",
              opacity: filterRowOpen ? 1 : 0.5,
            }}
            title={t("fileList.toggleFilterRow")}
            aria-pressed={filterRowOpen}
            data-filter-row-toggle="true"
          >
            <Icon name="filter_alt" size={16} />
          </button>
        )}
        {/* 新規フォルダ/ファイル。右クリックメニュー（背景・行の両方）と
            ⌘⇧N / ⌘N があるので、極端に狭いときは畳んで検索欄に幅を譲る。 */}
        {density !== "minimal" && (
        <button
          onClick={() => { setCreatingName(t("fileList.newFolder")); setCreatingType("dir"); }}
          className="flex items-center px-1 py-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
          style={{ color: "var(--kf-text-muted)" }}
          title={`${t("fileList.newFolderLabel")} (Ctrl+Shift+N)`}
        >
          <Icon name="create_new_folder" size={16} />
        </button>
        )}
        {density !== "minimal" && (
        <button
          onClick={() => { setCreatingName(`${t("fileList.newFolder")}.txt`); setCreatingType("file"); }}
          className="flex items-center px-1 py-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
          style={{ color: "var(--kf-text-muted)" }}
          title={`${t("fileList.newFileLabel")} (Ctrl+N)`}
        >
          <Icon name="note_add" size={16} />
        </button>
        )}
        <FileListViewControls
          tabId={tab.id}
          viewMode={viewMode}
          setViewMode={setViewMode}
          gridItemSize={gridItemSize}
          setGridItemSize={setGridItemSize}
          showTreemap={showTreemap}
          setShowTreemap={setShowTreemap}
          onRefresh={handleRefresh}
          syncNavEnabled={syncNavEnabled}
          setSyncNavEnabled={setSyncNavEnabled}
          compact={density === "minimal"}
        />
        {clipboard && (
          <span
            className="flex items-center gap-0.5 text-xs px-1"
            style={{ color: "var(--kf-text-muted)" }}
            title={t("fileList.clipboard", { count: clipboard.paths.length, mode: clipboard.mode === "copy" ? t("common.copy") : t("common.cut") })}
          >
            <Icon name={clipboard.mode === "copy" ? "content_copy" : "content_cut"} size={14} />
            <span>{clipboard.paths.length}</span>
          </span>
        )}
      </FileListSearchBar>

      {/* フィルタプリセット。極端に狭いペインでは既定で畳み、検索行の
          フィルタボタンで開く。ただし絞り込みが効いている間は必ず出す
          （隠れたまま一覧が絞られていると「空のフォルダ」に見えてしまう）。 */}
      {showFilterRow && (
      <FileListFilterPresets
        filterPreset={filterPreset}
        onSelectPreset={setFilterPreset}
        labelFilter={labelFilter}
        onSelectLabel={setLabelFilter}
        availableLabels={availableLabels}
        iconOnly={density !== "comfortable"}
        showAdvFilter={showAdvFilter}
        onToggleAdvFilter={() => setShowAdvFilter((v) => !v)}
        advFilterDirty={!!(sizeMin || sizeMax || dateMin || dateMax)}
      />
      )}

      {/* 詳細フィルタパネル */}
      {showAdvFilter && (
        <FileListFilterPanel
          sizeMin={sizeMin} setSizeMin={setSizeMin}
          sizeMax={sizeMax} setSizeMax={setSizeMax}
          sizeUnit={sizeUnit} setSizeUnit={setSizeUnit}
          dateMin={dateMin} setDateMin={setDateMin}
          dateMax={dateMax} setDateMax={setDateMax}
        />
      )}

      {/* 新規作成インライン入力 */}
      {creatingType && (
        <div
          className="flex flex-col border-b shrink-0"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
          onBlur={(e) => {
            // Confirm only when focus leaves the entire creation widget
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              handleCreate();
            }
          }}
        >
          <div className="flex items-center gap-2 px-3 py-1">
            <Icon
              name={creatingType === "dir" ? "create_new_folder" : "note_add"}
              size={14}
              style={{ color: "var(--kf-accent)", flexShrink: 0 }}
            />
            <input
              ref={creatingInputRef}
              value={creatingName}
              onChange={(e) => setCreatingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleCreate(); }
                if (e.key === "Escape") { setCreatingType(null); setCreatingName(""); setSelectedTemplate(""); }
              }}
              placeholder={creatingType === "dir" ? t("fileList.newFolderPlaceholder") : t("fileList.newFilePlaceholder")}
              className="flex-1 bg-transparent outline-none text-xs"
              style={{
                color: "var(--kf-text-primary)",
                borderBottom: "1px solid var(--kf-accent)",
                paddingBottom: "1px",
              }}
              onClick={(e) => { e.currentTarget.select(); }}
            />
            <span className="text-[10px]" style={{ color: "var(--kf-text-muted)", flexShrink: 0 }}>
              Enter / Esc
            </span>
          </div>
          {/* テンプレート選択 (#47) */}
          {creatingType === "file" && templates.length > 0 && (
            <div className="flex items-center gap-2 px-3 pb-1">
              <Icon name="file_copy" size={12} style={{ color: "var(--kf-text-muted)", flexShrink: 0 }} />
              <select
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                className="flex-1 bg-transparent outline-none text-[10px]"
                style={{ color: "var(--kf-text-muted)", cursor: "pointer" }}
              >
                <option value="">{t("fileList.emptyFile")}</option>
                {templates.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* エラー */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b shrink-0"
          style={{ backgroundColor: "color-mix(in srgb, var(--kf-error) 8%, transparent)", borderColor: "color-mix(in srgb, var(--kf-error) 20%, transparent)", color: "var(--kf-error)" }}>
          <Icon name="error" size={13} style={{ flexShrink: 0 }} />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity" title={t("common.close")}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {/* ホームビュー（パスが空のとき） */}
      {!currentPath && (
        <FileListHomeView
          volumes={volumes}
          bookmarks={homeBookmarks}
          recent={homeRecent}
          onNavigate={navigateUser}
          onOpenTrash={() => dispatch({ type: "ADD_TAB", paneId, tab: { id: genId(), paneType: "trash", title: t("toolbar.trash") } })}
        />
      )}

      {/* ファイル一覧 */}
      {currentPath && loading ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 読み込み中バー。read_dir は OS 側で中断できないため、キャンセルは
              「結果を捨てて直前の一覧に戻る」操作。ネットワークボリューム等で
              数十秒返らないときに、別パスへ移動し直す出口になる。 */}
          <div
            className="flex items-center gap-2 px-3 py-1 text-xs border-b shrink-0"
            style={{ borderColor: "var(--kf-border)", color: "var(--kf-text-secondary)" }}
          >
            <Icon name="sync" size={12} style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} />
            <span className="truncate flex-1" title={loadingPath ?? undefined}>{t("fileList.loadingDir")}</span>
            <button
              onClick={() => { cancelNavigation(); void cancelDirSizeScans(); }}
              className="shrink-0 kf-btn kf-btn-secondary"
              style={{ padding: "0 6px", height: 18, fontSize: 11 }}
              title={t("fileList.cancelLoadTooltip")}
            >
              {t("fileList.cancelLoad")}
            </button>
          </div>
          {viewMode !== "details" ? (
          /* グリッド・一覧スケルトン */
          <div className="flex-1 overflow-y-auto p-2">
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))" }}>
              {Array.from({ length: 24 }, (_, i) => (
                <div key={i} className="flex flex-col items-center gap-1 p-2">
                  <div className="skeleton-shimmer rounded" style={{ width: 40, height: 40 }} />
                  <div className="skeleton-shimmer h-2 rounded w-full" />
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* リストスケルトン */
          <div className="flex-1 overflow-hidden">
            {Array.from({ length: 30 }, (_, i) => (
              <div key={i} className="flex items-center gap-2 px-2" style={{ height: 22 }}>
                <div className="skeleton-shimmer shrink-0 rounded" style={{ width: 14, height: 14 }} />
                <div className="skeleton-shimmer h-2.5 rounded" style={{ width: `${30 + (i * 19 % 50)}%` }} />
                <div className="skeleton-shimmer h-2.5 rounded ml-auto shrink-0" style={{ width: 48 }} />
                <div className="skeleton-shimmer h-2.5 rounded shrink-0" style={{ width: 80 }} />
              </div>
            ))}
          </div>
          )}
        </div>
      ) : currentPath && viewMode !== "details" ? (
        /* サムネイル表示 / 一覧表示（どちらもタイルを並べる同じ土台を使う） */
        <div
          ref={gridContainerRef}
          className="flex-1 overflow-y-auto p-2 relative"
          onMouseDown={onGridMouseDown}
          onContextMenu={handleBgContextMenu}
          onDragOver={onBgDragOver}
          onDrop={onBgDrop}
        >
          {/* Rubber-band selection overlay */}
          {rubberBand && (() => {
            const scrollTop = gridContainerRef.current?.scrollTop ?? 0;
            const left = Math.min(rubberBand.x1, rubberBand.x2);
            const top = Math.min(rubberBand.y1, rubberBand.y2) - scrollTop;
            const width = Math.abs(rubberBand.x2 - rubberBand.x1);
            const height = Math.abs(rubberBand.y2 - rubberBand.y1);
            return (
              <div
                className="pointer-events-none absolute z-10 border"
                style={{
                  left,
                  top,
                  width,
                  height,
                  backgroundColor: "rgba(var(--kf-accent-rgb, 99,102,241), 0.15)",
                  borderColor: "var(--kf-accent)",
                }}
              />
            );
          })()}
          {displayEntries.length === 0 && !error ? (
            <div className="flex flex-col items-center justify-center gap-3 h-full min-h-[200px]" style={{ color: "var(--kf-text-muted)" }}>
              <Icon name={searchQuery ? "search_off" : "folder_open"} size={48} style={{ opacity: 0.3 }} />
              <div className="flex flex-col items-center gap-1 text-center">
                <span className="text-sm" style={{ color: "var(--kf-text-secondary)" }}>
                  {searchQuery ? t("fileList.noMatchingFiles") : t("fileList.emptyDirectory")}
                </span>
                {searchQuery && (
                  <span className="text-xs">{t("fileList.noSearchMatch", { query: searchQuery })}</span>
                )}
              </div>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80"
                  style={{ backgroundColor: "var(--kf-bg-tertiary)", border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)" }}
                >
                  <Icon name="close" size={12} />
                  {t("fileList.clearSearch")}
                </button>
              )}
            </div>
          ) : (
            <div
              role="listbox"
              aria-multiselectable="true"
              aria-label={t("fileList.fileListLabel", "ファイル一覧")}
              className={isCompact ? "grid gap-x-2 gap-y-0.5" : "grid gap-2"}
              style={{
                // 一覧表示はサムネイルを持たないぶん1行が細いので、名前が読める
                // 幅で多段に詰める。サムネイル表示は従来どおり一辺で段数を決める。
                gridTemplateColumns: isCompact
                  ? "repeat(auto-fill, minmax(200px, 1fr))"
                  : `repeat(auto-fill, minmax(${gridItemSize}px, 1fr))`,
              }}
            >
              {displayEntries.map((entry) => {
                const isSelected = selected.has(entry.path);
                const isImg = IMAGE_EXTS.has(entry.extension?.toLowerCase() ?? "");
                const isCut = clipboard?.mode === "cut" && clipboard.paths.includes(entry.path);
                const isDragOver = dragOverDir === entry.path;
                return (
                  <div
                    key={entry.path}
                    role="option"
                    aria-selected={isSelected}
                    data-grid-item
                    data-path={entry.path}
                    // グリッドは一覧より情報が少ないため、ホバーで名前・サイズ・更新日を補完
                    title={[
                      entry.name,
                      entry.isDir ? t("fileList.typeFolder") : formatSize(entry.size),
                      formatDate(entry.modified, dateRelative),
                    ].join("\n")}
                    className={
                      isCompact
                        ? "flex flex-row items-center gap-1.5 px-1.5 py-0.5 rounded cursor-pointer select-none"
                        : "flex flex-col items-center gap-1 p-1.5 rounded cursor-pointer select-none"
                    }
                    style={{
                      backgroundColor: isDragOver
                        ? "color-mix(in srgb, var(--kf-accent) 32%, transparent)"
                        : isSelected ? "var(--kf-sel-bg)" : undefined,
                      // 濃い選択塗りの上なので文字は白へ反転する。
                      color: isSelected && !isDragOver ? "var(--kf-sel-fg)" : "var(--kf-text-primary)",
                      border: `1px solid ${isSelected && !isDragOver ? "color-mix(in srgb, var(--kf-accent) 66%, transparent)" : "transparent"}`,
                      // drop ターゲットは選択（1px の淡いボーダー）と紛らわしかったため、
                      // 一覧表示と同じくアクセント色の 2px リングで明示する。
                      outline: isDragOver ? "2px solid var(--kf-accent)" : undefined,
                      outlineOffset: "-2px",
                      opacity: isCut ? 0.5 : entry.isHidden ? 0.6 : 1,
                      transition: "background-color 140ms ease, border-color 140ms ease",
                    }}
                    onMouseEnter={(e) => { if (!isSelected && !isDragOver) (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                    onMouseLeave={(e) => { if (!isSelected && !isDragOver) (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                    onClick={(e) => onEntryClick(entry, e)}
                    onDoubleClick={() => onEntryDoubleClick(entry)}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                    draggable
                    onDragStart={(e) => onDragStart(e, entry)}
                    onDragEnd={onDragEnd}
                    onDragOver={entry.isDir ? (e) => onDragOver(e, entry.path) : undefined}
                    onDragLeave={entry.isDir ? onDragLeave : undefined}
                    onDrop={entry.isDir ? (e) => onDrop(e, entry.path) : undefined}
                  >
                    {/* Thumbnail or icon（一覧表示ではサムネイルを出さず小さなアイコンだけ） */}
                    <div
                      className="relative flex items-center justify-center rounded-md overflow-hidden"
                      style={{
                        width: isCompact ? 16 : gridItemSize,
                        height: isCompact ? 16 : gridItemSize,
                        backgroundColor: isCompact ? undefined : "var(--kf-bg-tertiary)",
                        flexShrink: 0,
                      }}
                    >
                    {pinnedPaths.has(entry.path) && (
                      <Icon name="keep" size={12} title={t("fileList.pinned")} style={{ position: "absolute", top: 2, right: 2, color: "var(--kf-accent)", zIndex: 1 }} />
                    )}
                      {isImg && !entry.isDir && !isCompact ? (
                        <img
                          src={convertFileSrc(entry.path)}
                          alt={entry.name}
                          className="w-full h-full object-cover"
                          // 画像自体のネイティブドラッグを無効化（親タイルの D&D 移動を優先）
                          draggable={false}
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <FileIcon entry={entry} isSelected={isSelected} size={isCompact ? 16 : Math.round(gridItemSize * 0.42)} />
                      )}
                    </div>
                    <span
                      className={isCompact ? "text-xs leading-tight min-w-0 flex-1 truncate" : "text-[11px] text-center leading-tight w-full"}
                      style={{
                        color: isSelected ? "var(--kf-sel-fg)" : "var(--kf-text-secondary)",
                        // サムネイル表示は名前を2行まで折り返す。一覧表示は1行に収める。
                        ...(isCompact
                          ? {}
                          : {
                              overflow: "hidden",
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                            }),
                      } as React.CSSProperties}
                    >
                      <HighlightName name={entry.name} query={searchQuery.trim()} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : currentPath ? (
        // data-file-content: 列ヘッダーと一覧本体をまとめた「コンテンツ面」。
        // Windows 11 テーマではこの面を Mica 相当の背景から浮かせるため、
        // CSS（[data-ui-style="win11"]）から掴めるよう目印を付けている。
        <div className="flex-1 flex flex-col overflow-hidden" data-file-content>
          {/* ヘッダー（クリックでソート・右クリックで列選択） - 仮想リストの外に固定。
              極端に狭いペインでは畳む。ソートは背景の右クリックメニューから、
              現在のソート順はウィンドウ下部のステータスバーから確認できる。 */}
          {density !== "minimal" && (
          <div
            className="grid px-3 py-1 text-xs shrink-0 border-b"
            style={{
              gridTemplateColumns: gridTemplate,
              color: "var(--kf-text-muted)",
              backgroundColor: "var(--kf-bg-primary)",
              borderColor: "var(--kf-border-soft)",
            }}
            onContextMenu={(e) => { e.preventDefault(); setHeaderMenuPos({ x: e.clientX, y: e.clientY }); }}
          >
            <span style={{ paddingLeft: 4, paddingRight: 4, ...(showColumnDividers ? { borderRight: "1px solid var(--kf-border-soft)" } : {}) }} />
            <div className="flex items-center" style={{ paddingLeft: 6, paddingRight: 6, ...(showColumnDividers ? { borderRight: "1px solid var(--kf-border-soft)" } : {}) }}>
              {headerCell("name", t("fileList.colName"))}
            </div>
            {visibleColsList.map((col, colIdx, colArr) => {
              const labels: Record<OptionalCol, string> = { size: t("fileList.colSize"), modified: t("fileList.colDate"), ext: t("fileList.colExt"), type: t("fileList.colType") };
              const isLastCol = colIdx === colArr.length - 1;
              return (
                <div key={col} data-col={col} className="flex items-center justify-end relative" style={{ minWidth: 0, paddingLeft: 6, paddingRight: 6, ...(showColumnDividers && !isLastCol ? { borderRight: "1px solid var(--kf-border-soft)" } : {}) }}>
                  {/* Resize handle on right edge */}
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize z-10 select-none"
                    style={{ touchAction: "none" }}
                    onMouseDown={(e) => { e.preventDefault(); startColResize(col, e.clientX); }}
                    title={t("fileList.resizeCol")}
                  />
                  {col === "modified" ? (
                    <div className="flex items-center gap-0.5 justify-end w-full overflow-hidden">
                      {headerCell(col, labels[col], "text-right justify-end")}
                      <button
                        className="shrink-0 opacity-50 hover:opacity-100"
                        title={dateRelative ? t("fileList.switchAbsDate") : t("fileList.switchRelDate")}
                        onClick={(e) => { e.stopPropagation(); const next = !dateRelative; setDateRelative(next); localStorage.setItem("kf-date-relative", next ? "1" : "0"); }}
                      >
                        <Icon name={dateRelative ? "schedule" : "calendar_today"} size={10} />
                      </button>
                    </div>
                  ) : (
                    headerCell(col, labels[col], "text-right justify-end")
                  )}
                </div>
              );
            })}
          </div>
          )}

          {/* コンテンツ検索結果 */}
          {isContentActive && (
            <div className="flex-1 overflow-y-auto text-xs">
              {grepLoading && grepResults.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-8" style={{ color: "var(--kf-text-muted)" }}>
                  <Icon name="progress_activity" size={16} className="animate-spin" style={{ color: "var(--kf-accent)" }} />
                  <span>{t("fileList.searching")}</span>
                </div>
              )}
              {!grepLoading && grepResults.length === 0 && searchQuery.trim() && (
                <div className="flex flex-col items-center justify-center gap-2 py-8" style={{ color: "var(--kf-text-muted)" }}>
                  <Icon name="search_off" size={32} style={{ opacity: 0.4 }} />
                  <span>{t("fileList.noMatch")}</span>
                </div>
              )}
              {(() => {
                const byFile = grepResults.reduce<Map<string, GrepMatch[]>>((map, m) => {
                  const list = map.get(m.path) ?? [];
                  list.push(m);
                  map.set(m.path, list);
                  return map;
                }, new Map());
                return Array.from(byFile.entries()).map(([filePath, matches]) => {
                  const relPath = filePath.slice(currentPath.length).replace(/^[\\/]/, "");
                  return (
                    <div key={filePath}>
                      <div
                        className="flex items-center gap-1.5 px-3 py-1 sticky top-0 cursor-pointer"
                        style={{
                          backgroundColor: "var(--kf-bg-secondary)",
                          borderBottom: "1px solid var(--kf-border-weak)",
                          color: "var(--kf-text-secondary)",
                        }}
                        onClick={() => onSelectFile?.(filePath)}
                        title={filePath}
                      >
                        <Icon name="description" size={12} style={{ flexShrink: 0 }} />
                        <span className="flex-1 truncate font-mono">{relPath}</span>
                        <span style={{ color: "var(--kf-text-muted)" }}>{matches.length}</span>
                      </div>
                      {matches.map((m) => (
                        <div
                          key={`${m.path}:${m.lineNumber}`}
                          className="flex items-start gap-2 px-3 py-1 cursor-pointer"
                          style={{ borderBottom: "1px solid var(--kf-border-weak)" }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                          onClick={() => onSelectFile?.(m.path)}
                        >
                          <span className="font-mono shrink-0" style={{ color: "var(--kf-accent)", minWidth: 28, textAlign: "right" }}>
                            {m.lineNumber}
                          </span>
                          <span className="truncate font-mono" style={{ color: "var(--kf-text-secondary)" }}>
                            {(() => {
                              const q = searchQuery.trim();
                              const idx = m.line.toLowerCase().indexOf(q.toLowerCase());
                              if (idx === -1) return m.line.trim();
                              const trimmed = m.line.trim();
                              const offset = m.line.length - m.line.trimStart().length;
                              const hi = idx - offset;
                              return (
                                <>
                                  {trimmed.slice(0, hi)}
                                  <span style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)", borderRadius: 2 }}>
                                    {trimmed.slice(hi, hi + q.length)}
                                  </span>
                                  {trimmed.slice(hi + q.length)}
                                </>
                              );
                            })()}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                });
              })()}
              {grepResults.length >= 500 && (
                <div className="px-3 py-2 text-center" style={{ color: "var(--kf-text-muted)" }}>
                  {t("fileList.tooManyResults")}
                </div>
              )}
            </div>
          )}

          {/* 「上の階層へ」行。一覧の一番上に固定で置き、ドロップで親フォルダへ移動できる
              ようにする。仮想スクロールの内側ではなく外に置くのが要点で、中に入れると
              下までスクロールしたときに画面外へ消えてドロップ先にできなくなる。
              クリックすれば従来どおり親フォルダへ移動する（".." 行として使える）。 */}
          {hasParentDir && !isContentActive && (
            <div
              role="button"
              tabIndex={-1}
              data-parent-drop="true"
              aria-label={t("fileList.dropToParent")}
              title={t("fileList.dropToParent")}
              onClick={navigateUp}
              className="flex items-center gap-1.5 px-3 shrink-0 cursor-pointer select-none"
              style={{
                height: 22,
                borderBottom: "1px solid var(--kf-border-soft)",
                // ドロップ先の見せ方はフォルダ行と揃える（アクセント色の 2px リング）
                backgroundColor: dragOverUpRow
                  ? "color-mix(in srgb, var(--kf-accent) 32%, transparent)"
                  : "var(--kf-bg-secondary)",
                outline: dragOverUpRow ? "2px solid var(--kf-accent)" : undefined,
                outlineOffset: -2,
                color: dragOverUpRow ? "var(--kf-text-primary)" : "var(--kf-text-muted)",
              }}
              // dragover では types を見ない。WKWebView（macOS 実機）はドラッグ中の
              // dataTransfer.types にカスタム MIME を出さないことがあり、ここで
              // 弾くと実機だけハイライトもドロップも効かなくなる。フォルダ行が
              // types を見ていないのも同じ理由。実際に受け付けるかは onUpDrop 側で
              // ペイロードを読んで判断するので、ここで通しても害はない。
              // dragenter でも同じ処理をする。行が薄い（22px）ので、カーソルが
              // 入った直後に止まると dragover が 1 度も来ずハイライトが点かない。
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverUpRow(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = internalDropEffect(e.dataTransfer);
                setDragOverUpRow(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverUpRow(false);
              }}
              onDrop={(e) => { setDragOverUpRow(false); onUpDrop(e); }}
            >
              <Icon name="drive_folder_upload" size={13} style={{ flexShrink: 0 }} />
              <span className="text-xs">..</span>
              <span className="text-[10px] truncate opacity-70">{parentDirName}</span>
            </div>
          )}

          {/* 仮想スクロールコンテナ */}
          <div ref={scrollParentRef} className={`flex-1 overflow-y-auto${isContentActive ? " hidden" : ""}`} onContextMenu={handleBgContextMenu} onDragOver={onBgDragOver} onDrop={onBgDrop}>
            {displayEntries.length === 0 && !error ? (
              <div
                className="flex flex-col items-center justify-center gap-3 h-full min-h-[200px]"
                style={{ color: "var(--kf-text-muted)" }}
              >
                <Icon name={searchQuery ? "search_off" : "folder_open"} size={48} style={{ opacity: 0.3 }} />
                <div className="flex flex-col items-center gap-1 text-center">
                  <span className="text-sm" style={{ color: "var(--kf-text-secondary)" }}>
                    {searchQuery ? t("fileList.noMatchingFiles") : t("fileList.emptyDirectory")}
                  </span>
                  {searchQuery && (
                    <span className="text-xs">{t("fileList.noSearchMatch", { query: searchQuery })}</span>
                  )}
                </div>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:opacity-80"
                    style={{ backgroundColor: "var(--kf-bg-tertiary)", border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)" }}
                  >
                    <Icon name="close" size={12} />
                    {t("fileList.clearSearch")}
                  </button>
                )}
              </div>
            ) : (
              <div
                role="listbox"
                aria-multiselectable="true"
                aria-label={t("fileList.fileListLabel", "ファイル一覧")}
                style={{
                  height: virtualizer.getTotalSize(),
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const index = virtualRow.index;
                  const entry = displayEntries[index];
                  const isSelected = selected.has(entry.path);
                  const isFocused = index === focusedIndex;
                  const isDragOver = dragOverDir === entry.path;
                  const isCut = clipboard?.mode === "cut" && clipboard.paths.includes(entry.path);
                  const isRenaming = renamingPath === entry.path;
                  const relDir = isRecursiveActive
                    ? entry.path.slice(currentPath.length).replace(/[\\/][^\\/]+$/, "").replace(/^[\\/]/, "") || "."
                    : null;

                  // Renaming row: render inline (uses parent state that changes
                  // every keystroke — memoization would not help). At most one
                  // row is being renamed at any time.
                  if (isRenaming) {
                    return (
                      <div
                        key={virtualRow.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <div
                          role="option"
                          aria-selected={isSelected}
                          className="grid px-3 py-0.5 h-full items-center cursor-pointer select-none"
                          style={{
                            gridTemplateColumns: gridTemplate,
                            backgroundColor: isSelected ? "var(--kf-sel-bg)" : undefined,
                            color: isSelected ? "var(--kf-sel-fg)" : "var(--kf-text-primary)",
                            outline: isFocused && !isSelected ? "1px solid var(--kf-accent)" : undefined,
                            outlineOffset: "-1px",
                            borderBottom: showRowDividers ? "1px solid var(--kf-border-soft)" : undefined,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", paddingLeft: 4, paddingRight: 4, ...(showColumnDividers ? { borderRight: "1px solid var(--kf-border-soft)" } : {}) }}>
                            <FileIcon entry={entry} isSelected={isSelected} />
                          </div>
                          <div className="flex items-center gap-1 min-w-0" onClick={(e) => e.stopPropagation()} style={{ paddingLeft: 6, paddingRight: 6, ...(showColumnDividers ? { borderRight: "1px solid var(--kf-border-soft)" } : {}) }}>
                            <input
                              className="text-xs bg-transparent border-b outline-none flex-1 min-w-0"
                              style={{
                                color: isSelected ? "var(--kf-sel-fg)" : "var(--kf-text-primary)",
                                borderColor: "var(--kf-accent)",
                              }}
                              value={renameValue}
                              autoFocus
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename();
                                if (e.key === "Escape") {
                                  isCancelingRenameRef.current = true;
                                  setRenamingPath(null);
                                }
                              }}
                              onBlur={() => {
                                if (isCancelingRenameRef.current) {
                                  isCancelingRenameRef.current = false;
                                  return;
                                }
                                commitRename();
                              }}
                            />
                            <button
                              title={t("fileList.cancelEscape")}
                              className="shrink-0 opacity-50 hover:opacity-100 flex items-center"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                isCancelingRenameRef.current = true;
                                setRenamingPath(null);
                              }}
                            >
                              <Icon name="close" size={12} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <FileRow
                      key={virtualRow.key}
                      entry={entry}
                      isSelected={isSelected}
                      isFocused={isFocused}
                      isDragOver={isDragOver}
                      isCut={isCut}
                      isPinned={pinnedPaths.has(entry.path)}
                      colorLabel={colorLabels[entry.path]}
                      diffStatus={null}
                      dirSize={dirSizes.get(entry.path)}
                      showDirSizes={showDirSizes}
                      showColumnDividers={showColumnDividers}
                      showRowDividers={showRowDividers}
                      visibleColsList={visibleColsList}
                      gridTemplate={gridTemplate}
                      relDir={relDir}
                      searchQuery={searchQuery.trim()}
                      dateRelative={dateRelative}
                      virtualRowSize={virtualRow.size}
                      virtualRowStart={virtualRow.start}
                      isDirDroppable={entry.isDir}
                      onClick={onEntryClick}
                      onDoubleClick={onEntryDoubleClick}
                      onContextMenu={handleContextMenu}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      onDragOver={onDragOver}
                      onDragLeave={onDragLeave}
                      onDrop={onDrop}
                      labels={rowLabels}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* ヘッダー右クリックメニュー：列の表示/非表示 */}
      {headerMenuPos && (
        <div
          ref={headerMenuRef}
          className="fixed z-50 rounded shadow-xl py-1 text-xs"
          style={{
            left: headerMenuPos.x,
            top: headerMenuPos.y,
            backgroundColor: "var(--kf-bg-secondary)",
            border: "1px solid var(--kf-border)",
            color: "var(--kf-text-primary)",
            minWidth: 140,
          }}
        >
          <div className="px-3 py-1 font-semibold" style={{ color: "var(--kf-text-muted)" }}>{t("fileList.columnVisibility")}</div>
          {ALL_OPTIONAL_COLS.map((col) => {
            const labels: Record<OptionalCol, string> = { size: t("fileList.colSize"), modified: t("fileList.colDate"), ext: t("fileList.colExt"), type: t("fileList.colType") };
            return (
              <label
                key={col}
                className="flex items-center gap-2 px-3 py-1 cursor-pointer hover:opacity-80"
              >
                <input
                  type="checkbox"
                  checked={visibleCols.has(col)}
                  onChange={() => {
                    setVisibleCols((prev) => {
                      const next = new Set(prev);
                      if (next.has(col)) next.delete(col);
                      else next.add(col);
                      localStorage.setItem(`kf-visible-cols-${tab.id}`, JSON.stringify([...next]));
                      return next;
                    });
                  }}
                />
                {labels[col]}
              </label>
            );
          })}
        </div>
      )}

      {/* プロパティダイアログ */}
      {propertiesPath && (
        <PropertiesDialog
          path={propertiesPath}
          onClose={() => setPropertiesPath(null)}
        />
      )}

      {/* バッチリネームダイアログ */}
      {showBatchRename && (
        <BatchRenameDialog
          entries={displayEntries.filter((e) => selected.has(e.path))}
          onClose={() => setShowBatchRename(false)}
          onDone={() => navigate(currentPath)}
        />
      )}

      {/* diff ビュー */}
      {diffPaths && (
        <DiffViewer
          pathA={diffPaths.a}
          pathB={diffPaths.b}
          onClose={() => setDiffPaths(null)}
        />
      )}

      {/* 画像ビューア */}
      {imageViewer && (
        <ImageViewer
          path={imageViewer.path}
          siblings={imageViewer.siblings}
          onClose={() => setImageViewer(null)}
        />
      )}

      {/* コンテキストメニューエディター */}
      {showMenuEditor && (
        <ContextMenuEditor onClose={() => setShowMenuEditor(false)} />
      )}

      {/* タグ編集（右クリックメニューから） */}
      {tagDialogPaths && (
        <TagDialog paths={tagDialogPaths} onClose={() => setTagDialogPaths(null)} />
      )}

      {/* アーカイブブラウザ */}
      {archiveBrowserPath && (
        <ArchiveBrowser archivePath={archiveBrowserPath} onClose={() => setArchiveBrowserPath(null)} />
      )}

      {/* 圧縮ダイアログ */}
      {compressTargets && (
        <CompressDialog
          sources={compressTargets}
          destDir={currentPath}
          defaultName={compressTargets.length === 1
            ? compressTargets[0].split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "")
            : "archive"}
          onClose={() => setCompressTargets(null)}
          onDone={() => navigate(currentPath)}
        />
      )}

      {/* 競合ダイアログ */}
      {conflictInfo && (
        <ConflictDialog
          files={conflictInfo.files}
          onResolve={conflictInfo.resolve}
        />
      )}

      {/* スペースバープレビュー */}
      {quickPreviewPath && (
        <QuickPreviewModal
          path={quickPreviewPath}
          siblings={filteredEntries.filter(e => !e.isDir).map(e => e.path)}
          onClose={() => setQuickPreviewPath(null)}
        />
      )}

      {/* パターン選択ダイアログ */}
      {patternDialog && (
        <div
          className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
          onClick={() => setPatternDialog(null)}
        >
          <div
            className="kf-anim-scale rounded-lg shadow-xl p-4 flex flex-col gap-3"
            style={{ backgroundColor: "var(--kf-bg-primary)", border: "1px solid var(--kf-border)", minWidth: 320 }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, fontSize: 13, color: "var(--kf-text-primary)" }}>
              {patternDialog === "add" ? t("fileList.selectByPattern") : t("fileList.deselectByPattern")}
            </div>
            <div style={{ fontSize: 11, color: "var(--kf-text-muted)" }}>
              {t("fileList.filterExamples")}
            </div>
            <input
              autoFocus
              value={patternInput}
              onChange={e => setPatternInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") { setPatternDialog(null); return; }
                if (e.key === "Enter") {
                  const pat = patternInput.trim();
                  if (!pat) { setPatternDialog(null); return; }
                  const re = new RegExp(
                    "^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
                    "i"
                  );
                  setSelected(prev => {
                    const next = new Set(prev);
                    for (const fe of filteredEntries) {
                      if (re.test(fe.name)) {
                        if (patternDialog === "add") next.add(fe.path);
                        else next.delete(fe.path);
                      }
                    }
                    return next;
                  });
                  setPatternDialog(null);
                }
              }}
              placeholder={t("fileList.patternPlaceholder")}
              style={{
                padding: "6px 10px", borderRadius: 4,
                border: "1px solid var(--kf-border)",
                backgroundColor: "var(--kf-bg-secondary)",
                color: "var(--kf-text-primary)", fontSize: 13, outline: "none",
              }}
            />
            <div style={{ fontSize: 11, color: "var(--kf-text-muted)" }}>
              {t("fileList.filterConfirmHint")}
            </div>
          </div>
        </div>
      )}

      {/* コンテキストメニュー */}
      {/* 空白部分の右クリックメニュー */}
      {bgMenu && (
        <ContextMenu
          x={bgMenu.x}
          y={bgMenu.y}
          onClose={() => setBgMenu(null)}
          items={[
            {
              type: "item",
              label: t("fileList.newFolderLabel"),
              icon: "create_new_folder",
              action: () => { setBgMenu(null); setCreatingName(t("fileList.newFolder")); setCreatingType("dir"); },
            },
            {
              type: "item",
              label: t("fileList.newFileLabel"),
              icon: "note_add",
              action: () => { setBgMenu(null); setCreatingName(`${t("fileList.newFolder")}.txt`); setCreatingType("file"); },
            },
            { type: "separator" },
            {
              type: "item",
              label: t("common.paste"),
              icon: "content_paste",
              shortcut: shortcutLabelFor(bindings, "clipboard.paste"),
              disabled: !clipboard && !osClipboardHasFiles,
              action: () => handlePaste(),
            },
            { type: "separator" },
            // 並び替え。列ヘッダのクリックが唯一の入口だったため、
            // 狭いペインでヘッダを畳むとソートできなくなる。ここに逃がす。
            { type: "label", label: t("fileList.sortBy") },
            ...(["name", ...ALL_OPTIONAL_COLS] as SortKey[]).map((key) => ({
              type: "item" as const,
              label: {
                name: t("fileList.colName"),
                size: t("fileList.colSize"),
                modified: t("fileList.colDate"),
                ext: t("fileList.colExt"),
                type: t("fileList.colType"),
              }[key],
              icon: sortKey === key ? (sortDir === "asc" ? "arrow_upward" : "arrow_downward") : "swap_vert",
              iconColor: sortKey === key ? "var(--kf-accent)" : undefined,
              action: () => { handleSort(key); setBgMenu(null); },
            })),
            { type: "separator" },
            {
              type: "item",
              label: t("fileList.refreshShort"),
              icon: "refresh",
              shortcut: "F5",
              action: () => handleRefresh(),
            },
          ]}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            // 既定アクション（ダブルクリック相当）を Explorer/Finder 同様に先頭・強調で表示
            {
              type: "item",
              label: contextMenu.entry.isDir ? t("common.open") : t("fileList.openDefault"),
              icon: contextMenu.entry.isDir ? "folder_open" : "open_in_new",
              emphasis: true,
              action: () => {
                if (contextMenu.entry.isDir) navigate(contextMenu.entry.path);
                else {
                  const ext = (contextMenu.entry.extension ?? "").toLowerCase();
                  const customApp = fileAssociations[ext];
                  if (customApp) {
                    invoke("open_with_app", { filePath: contextMenu.entry.path, appPath: customApp }).catch(console.error);
                  } else {
                    openWithDefaultApp(contextMenu.entry.path).catch(console.error);
                  }
                }
              },
            },
            // フォルダは中身を開くものでプレビュー対象ではないため、ファイルのみ。
            ...(contextMenu.entry.isDir
              ? []
              : [
                  {
                    type: "item" as const,
                    label: t("fileList.showInPreview"),
                    icon: "visibility",
                    shortcut: "Space",
                    // 端末上のファイルは実体を読めないため選べない。
                    disabled: isMtpPath(contextMenu.entry.path),
                    action: () => {
                      setContextMenu(null);
                      setQuickPreviewPath(contextMenu.entry.path);
                    },
                  },
                ]),
            { type: "separator" },
            {
              type: "item",
              label: t("common.copy"),
              icon: "content_copy",
              shortcut: shortcutLabelFor(bindings, "clipboard.copy"),
              action: () => handleCopy(contextMenu.paths),
            },
            {
              type: "item",
              label: t("common.cut"),
              icon: "content_cut",
              shortcut: shortcutLabelFor(bindings, "clipboard.cut"),
              // 端末（MTP）上のファイルは移動・削除に非対応。コピーだけ許す。
              disabled: contextMenu.paths.some(isMtpPath),
              action: () => handleCut(contextMenu.paths),
            },
            {
              type: "item",
              label: t("common.paste"),
              icon: "content_paste",
              shortcut: shortcutLabelFor(bindings, "clipboard.paste"),
              disabled: !clipboard && !osClipboardHasFiles,
              action: () => handlePaste(),
            },
            { type: "separator" },
            {
              type: "item",
              label: t("common.rename"),
              icon: "edit",
              shortcut: shortcutLabelFor(bindings, "file.rename"),
              disabled: contextMenu.paths.length !== 1 || contextMenu.paths.some(isMtpPath),
              action: () => startRename(contextMenu.entry),
            },
            {
              type: "item",
              label: t("fileList.batchRename"),
              icon: "drive_file_rename_outline",
              disabled: contextMenu.paths.length < 2,
              action: () => { setContextMenu(null); setShowBatchRename(true); },
            },
            {
              type: "item",
              label: t("fileList.deleteToTrash"),
              icon: "delete",
              shortcut: shortcutLabelFor(bindings, "file.delete"),
              // 端末（MTP）は取り出し専用。
              disabled: contextMenu.paths.some(isMtpPath),
              action: () => handleDelete(contextMenu.paths),
            },
            { type: "separator" },
            {
              type: "item",
              label: t("fileList.compress"),
              icon: "folder_zip",
              // mtp:// は圧縮側から見えず、中身ゼロのアーカイブになる。
              disabled: contextMenu.paths.some(isMtpPath),
              action: () => { setContextMenu(null); handleCompress(contextMenu.paths); },
            },
            { type: "separator" },
            ...(() => {
              if (!compareEnabled) return [];
              const otherEntries = Array.from(paneEntries.entries()).find(([id]) => id !== paneId)?.[1];
              const match = otherEntries?.find((e) => e.name.toLowerCase() === contextMenu.entry.name.toLowerCase());
              if (!match || contextMenu.entry.isDir) return [];
              return [
                {
                  type: "item" as const,
                  label: t("fileList.showDiff"),
                  icon: "difference",
                  action: () => { setContextMenu(null); setDiffPaths({ a: contextMenu.entry.path, b: match.path }); },
                },
                { type: "separator" as const },
              ];
            })(),
            // ── 整理: ピン留め・カラーラベル ─────────────────────────
            { type: "label", label: t("fileList.menuOrganize") },
            {
              type: "item",
              label: contextMenu.paths.every((p) => pinnedPaths.has(p)) ? t("fileList.unpin") : t("fileList.pin"),
              icon: contextMenu.paths.every((p) => pinnedPaths.has(p)) ? "keep_off" : "keep",
              action: () => { setContextMenu(null); handleTogglePin(contextMenu.paths); },
            },
            // カラーラベル: 6 行のメニュー項目ではなく 1 行の色見本で選ぶ
            {
              type: "colorRow" as const,
              colors: COLOR_LABEL_COLORS.map((color, i) => ({
                color,
                label: [t("colorLabels.red"), t("colorLabels.orange"), t("colorLabels.yellow"), t("colorLabels.green"), t("colorLabels.blue"), t("colorLabels.purple")][i],
                selected: contextMenu.paths.every((p) => colorLabels[p] === color),
                action: () => {
                  const allSame = contextMenu.paths.every((p) => colorLabels[p] === color);
                  handleSetColorLabel(contextMenu.paths, allSame ? null : color);
                  setContextMenu(null);
                },
              })),
            },
            ...(contextMenu.paths.some((p) => colorLabels[p])
              ? [{
                  type: "item" as const,
                  label: t("fileList.removeLabel"),
                  icon: "label_off",
                  action: () => { handleSetColorLabel(contextMenu.paths, null); setContextMenu(null); },
                }]
              : []),
            // タグ: 選択したものすべてに対して付け外しできるダイアログを開く。
            // 付いているタグ名をラベルに出して、開かなくても分かるようにする。
            {
              type: "item",
              label: (() => {
                const common = contextMenu.paths
                  .map((p) => getFileTags(p))
                  .reduce<string[] | null>((acc, list) => (acc === null ? list : acc.filter((x) => list.includes(x))), null) ?? [];
                return common.length > 0
                  ? t("fileList.tagsWith", { tags: common.join(", ") })
                  : t("fileList.tags");
              })(),
              icon: "sell",
              action: () => { setTagDialogPaths(contextMenu.paths); setContextMenu(null); },
            },
            { type: "separator" },
            {
              type: "item",
              label: t("fileList.copyPath"),
              icon: "content_copy",
              shortcut: shortcutLabelFor(bindings, "file.copyPath"),
              action: () => handleCopyPath(contextMenu.paths),
            },
            {
              type: "item",
              label: t("fileList.copyFilename"),
              icon: "badge",
              action: () => navigator.clipboard.writeText(contextMenu.paths.map((p) => p.split(/[\\/]/).pop() ?? p).join("\n")),
            },
            {
              type: "item",
              label: t("fileList.openInExplorer"),
              icon: "folder_open",
              action: () => handleRevealInExplorer(contextMenu.entry.path),
            },
            ...(contextMenu.entry.isDir
              ? [{
                  type: "item" as const,
                  label: t("fileList.addToFavorites"),
                  icon: "star",
                  action: () => {
                    addBookmark(contextMenu.entry.path).catch((e) => console.error("[addBookmark]", e));
                    setContextMenu(null);
                  },
                }]
              : []),
            {
              type: "item",
              label: t("fileList.osContextMenu"),
              icon: "more_horiz",
              action: () => {
                const { paths, screenX, screenY } = contextMenu;
                setContextMenu(null);
                invoke("show_shell_context_menu", { paths, screenX, screenY }).catch(console.error);
              },
            },
            // プレビュー対応の拡張子として登録/解除（単一ファイル・拡張子ありのみ）
            ...(!contextMenu.entry.isDir && contextMenu.entry.extension && contextMenu.paths.length === 1
              ? [{
                  type: "item" as const,
                  label: previewExtConfig[(contextMenu.entry.extension ?? "").toLowerCase()]
                    ? t("fileList.unregisterPreviewExt", "プレビュー登録を解除 (.{{ext}})", { ext: (contextMenu.entry.extension ?? "").toLowerCase() })
                    : t("fileList.registerPreviewExt", "プレビュー対応に登録（テキスト・.{{ext}}）", { ext: (contextMenu.entry.extension ?? "").toLowerCase() }),
                  icon: "preview",
                  action: () => {
                    const e = (contextMenu.entry.extension ?? "").toLowerCase();
                    const next = { ...previewExtConfig };
                    if (next[e]) delete next[e]; else next[e] = "text" as const;
                    setUiSettings({ previewExtConfig: next });
                    setContextMenu(null);
                  },
                }]
              : []),
            {
              type: "item",
              label: t("fileList.createSymlink"),
              icon: "link",
              disabled: contextMenu.paths.length !== 1,
              action: async () => {
                const src = contextMenu.entry.path;
                const name = src.split(/[\\/]/).pop()!;
                const sep = currentPath.includes("\\") ? "\\" : "/";
                const link = await generateUniqueName(t("fileList.symlinkName", { base: `${currentPath}${sep}${name}` }));
                try {
                  await invoke("create_symlink", { src, link });
                  await navigate(currentPath);
                } catch (e) {
                  console.error("[create_symlink]", e);
                }
                setContextMenu(null);
              },
            },
            { type: "separator" },
            {
              type: "item",
              label: t("fileList.properties"),
              icon: "info",
              shortcut: shortcutLabelFor(bindings, "file.properties"),
              disabled: contextMenu.paths.length !== 1,
              action: () => setPropertiesPath(contextMenu.entry.path),
            },
            ...(HAS_SHELL_COMMANDS && customMenuItems.filter((item) => {
              if (item.on === "file") return !contextMenu.entry.isDir;
              if (item.on === "dir") return contextMenu.entry.isDir;
              return true;
            }).length > 0 ? [
              { type: "separator" as const },
              ...customMenuItems
                .filter((item) => {
                  if (item.on === "file") return !contextMenu.entry.isDir;
                  if (item.on === "dir") return contextMenu.entry.isDir;
                  return true;
                })
                .map((item) => ({
                  type: "item" as const,
                  label: item.label,
                  icon: item.icon || "open_in_new",
                  action: () => runCustomCommand(item.command, contextMenu.paths, contextMenu.entry),
                })),
            ] : []),
            ...(HAS_SHELL_COMMANDS ? [
              { type: "separator" as const },
              {
                type: "item" as const,
                label: t("fileList.customizeMenu"),
                icon: "settings",
                action: () => setShowMenuEditor(true),
              },
            ] : []),
          ]}
        />
      )}

      {/* ファイルタイプ統計フッター。
          極端に狭いペインではウィンドウ下部のステータスバーと内容が重複する
          （件数・選択数・ソート・表示モード）ので畳んで一覧に高さを譲る。 */}
      {density !== "minimal" && (() => {
        const dirs = displayEntries.filter((e) => e.isDir).length;
        const files = displayEntries.filter((e) => !e.isDir).length;
        const imgCount = displayEntries.filter((e) => !e.isDir && PRESET_EXTS.images.has((e.extension ?? "").toLowerCase())).length;
        const codeCount = displayEntries.filter((e) => !e.isDir && PRESET_EXTS.code.has((e.extension ?? "").toLowerCase())).length;
        return (
          <div
            className="flex items-center gap-3 px-3 py-0.5 border-t shrink-0 text-[10px] overflow-x-auto"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)", color: "var(--kf-text-muted)" }}
          >
            <span className="flex items-center gap-0.5 shrink-0">
              <Icon name="folder" size={11} style={{ color: "var(--kf-accent)" }} />
              {dirs}
            </span>
            <span className="flex items-center gap-0.5 shrink-0">
              <Icon name="description" size={11} />
              {files}
            </span>
            {imgCount > 0 && (
              <span className="flex items-center gap-0.5 shrink-0">
                <Icon name="image" size={11} style={{ color: "#a78bfa" }} />
                {imgCount}
              </span>
            )}
            {codeCount > 0 && (
              <span className="flex items-center gap-0.5 shrink-0">
                <Icon name="code" size={11} style={{ color: "#60a5fa" }} />
                {codeCount}
              </span>
            )}
            {filterPreset !== "all" && (
              <span className="ml-auto shrink-0" style={{ color: "var(--kf-accent)" }}>
                {t("fileList.filtering")}
              </span>
            )}
          </div>
        );
      })()}

      {/* ディスク使用量ツリーマップ */}
      {showTreemap && currentPath && (
        <DiskTreemap
          rootPath={currentPath}
          onNavigate={(path) => navigate(path)}
          onClose={() => setShowTreemap(false)}
        />
      )}

    </div>
  );
}
