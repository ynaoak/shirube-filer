import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { FileEntry, ReadDirResult } from "../../types/fs";
import type { LayoutAction } from "../../store/layoutStore";
import { APP_EVENTS } from "../../lib/appEvents";
import { showToast } from "../../lib/toast";

/** FS 変更通知による一覧の再読込を、この間隔より頻繁には行わない。 */
const REFRESH_MIN_INTERVAL_MS = 500;

type UseDirEntriesArgs = {
  tabPath: string;
  tabId: string;
  initialHistory?: string[];
  initialHistoryIndex?: number;
  paneId: string;
  dispatch: React.Dispatch<LayoutAction>;
  setActivePaneId: (id: string | null) => void;
  setActiveTreePath: (path: string) => void;
  syncNavEnabled: boolean;
  /** ナビゲーション開始時に選択・検索・フォーカスをリセットするコールバック。
   *  useFileFilter（setSearchQuery）に依存するため ref 経由で受け取り循環を避ける。 */
  onNavigateReset: () => void;
};

export type UseDirEntriesReturn = {
  entries: FileEntry[];
  currentPath: string;
  loading: boolean;
  /** 読み込み中のパス（loading が false のときは null）。 */
  loadingPath: string | null;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  navigate: (path: string, updateHistory?: boolean, silent?: boolean) => Promise<void>;
  navigateUser: (path: string) => void;
  /** 進行中のディレクトリ読み込みを中断し、直前の一覧表示に戻す。 */
  cancelNavigation: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
};

/**
 * ディレクトリ読み込み（read_dir）とナビゲーション、履歴、ペイン同期、
 * ディレクトリ監視（fs:changed での自動更新）を 1 つのフックに集約する。
 * FileList から肥大した中核ロジックを切り出したもの。挙動は従来どおり。
 */
export function useDirEntries({
  tabPath,
  tabId,
  initialHistory,
  initialHistoryIndex,
  paneId,
  dispatch,
  setActivePaneId,
  setActiveTreePath,
  syncNavEnabled,
  onNavigateReset,
}: UseDirEntriesArgs): UseDirEntriesReturn {
  const { t } = useTranslation();

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(tabPath);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  // 同一ディレクトリ再読込の判定用（navigate の依存配列を安定に保つため ref 経由）
  const currentPathRef = useRef("");
  useEffect(() => { currentPathRef.current = currentPath; }, [currentPath]);

  // 進行中の read_dir を識別する世代番号。
  //
  // read_dir は数秒〜数十秒かかることがある（macOS のネットワークボリューム、
  // スリープ中の外付けディスク、初回アクセスで TCC の許可ダイアログが出る
  // Desktop/Documents など）。世代番号を持たないと、遅れて返ってきた古い読み込みが
  // 「その間にユーザーが移動した別パス」の一覧・currentPath・履歴・タブの path を
  // 上書きしてしまい、移動をキャンセルして別パスへ行っても元のパスへ引き戻される。
  // navigate / cancelNavigation のたびに採番し、世代が変わった結果はすべて破棄する。
  const navSeqRef = useRef(0);
  /** 別ディレクトリへの移動が進行中か（同一ディレクトリの自動再読込を抑止する）。 */
  const pendingNavRef = useRef(false);

  // History management (refs for stable access inside callbacks)
  const historyRef = useRef<string[]>(initialHistory?.length ? initialHistory : []);
  const historyIndexRef = useRef<number>(initialHistoryIndex ?? -1);
  const isSyncInitiatorRef = useRef(false);

  // selection/search/focus のリセットは循環依存回避のため ref 経由で最新版を呼ぶ
  const resetRef = useRef(onNavigateReset);
  resetRef.current = onNavigateReset;

  const navigate = useCallback(
    async (path: string, updateHistory = true, silent = false) => {
      // 同一ディレクトリの再読込（FS ウォッチャー起点など）は「差分更新」扱い:
      // スケルトン表示（setLoading）と選択・検索のリセットを行わない。
      // 仮想リストは key=path で行 DOM を再利用するため、entries の置換だけなら
      // 画面はぶれない。
      const isSameDirRefresh = silent && path === currentPathRef.current;
      // 別パスへの移動中に FS ウォッチャーの再読込を走らせない。
      // 移動先の読み込みが終わるまで currentPath は移動元のままなので、そのまま
      // 走らせると「移動元の再読込」が移動先の読み込みを追い越し、移動が巻き戻る。
      if (isSameDirRefresh && pendingNavRef.current) return;

      // この呼び出しの世代。これ以降に navigate / cancelNavigation が走ったら、
      // 本呼び出しの結果は「ユーザーがもう見ていない一覧」なので反映しない。
      const seq = ++navSeqRef.current;
      // Empty path → show home view (drive tile grid), don't invoke read_dir
      if (!path) {
        pendingNavRef.current = false;
        setLoading(false);
        setLoadingPath(null);
        setCurrentPath("");
        setEntries([]);
        return;
      }
      if (!isSameDirRefresh) {
        pendingNavRef.current = true;
        setLoading(true);
        setLoadingPath(path);
        resetRef.current();
      }
      setError(null);
      try {
        const result = await invoke<ReadDirResult>("read_dir", { path });
        // 中断済み、または別パスへ移動済み。古い一覧で画面を上書きしない。
        if (navSeqRef.current !== seq) return;
        setEntries(result.entries);
        setCurrentPath(result.path);

        if (updateHistory) {
          // Trim forward history then push
          const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
          const next = [...trimmed, result.path].slice(-50);
          historyRef.current = next;
          historyIndexRef.current = next.length - 1;
        }

        // silent=true: FS-triggered or cross-pane sync — don't steal the active pane
        if (!silent) {
          setActivePaneId(paneId);
          setActiveTreePath(result.path);
        }
        dispatch({
          type: "UPDATE_TAB",
          paneId,
          tabId,
          patch: {
            path: result.path,
            title: result.path.split(/[\\/]/).pop() || result.path,
            history: historyRef.current,
            historyIndex: historyIndexRef.current,
          },
        });

        // Broadcast sync-nav event to other panes (only if this pane initiated)
        if (syncNavEnabled && isSyncInitiatorRef.current) {
          window.dispatchEvent(new CustomEvent(APP_EVENTS.SYNC_NAV, { detail: { path: result.path, sourcePaneId: paneId } }));
        }
      } catch (e) {
        // 中断済みの読み込みの失敗は、ユーザーが既に離れたパスの話なので黙って捨てる。
        if (navSeqRef.current !== seq) return;
        console.error("[navigate]", e);
        showToast(t("fileList.failedOpenDir"));
      } finally {
        // 古い世代の後始末で、進行中の読み込みのスケルトンを消さない。
        if (navSeqRef.current === seq) {
          if (!isSameDirRefresh) {
            pendingNavRef.current = false;
            setLoading(false);
            setLoadingPath(null);
          }
          isSyncInitiatorRef.current = false;
        }
      }
    },
    [dispatch, paneId, tabId, syncNavEnabled, t]
  );

  // Listen for sync-nav events from other panes
  useEffect(() => {
    const handler = (e: Event) => {
      const { path, sourcePaneId } = (e as CustomEvent).detail as { path: string; sourcePaneId: string };
      if (sourcePaneId !== paneId && syncNavEnabled) {
        navigate(path, false, true); // silent: don't steal the active pane
      }
    };
    window.addEventListener(APP_EVENTS.SYNC_NAV, handler);
    return () => window.removeEventListener(APP_EVENTS.SYNC_NAV, handler);
  }, [paneId, syncNavEnabled, navigate]);

  // User-initiated navigate (marks this pane as sync initiator)
  const navigateUser = useCallback((path: string) => {
    isSyncInitiatorRef.current = true;
    navigate(path);
  }, [navigate]);

  // 読み込みの中断。read_dir 自体は OS 側で止められないが、世代を進めることで
  // 結果を破棄し、直前の一覧・パスのまま操作を続けられるようにする。
  const cancelNavigation = useCallback(() => {
    navSeqRef.current++;
    pendingNavRef.current = false;
    setLoading(false);
    setLoadingPath(null);
    isSyncInitiatorRef.current = false;
  }, []);

  const goBack = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    navigate(historyRef.current[historyIndexRef.current], false);
  }, [navigate]);

  const goForward = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    navigate(historyRef.current[historyIndexRef.current], false);
  }, [navigate]);

  useEffect(() => {
    navigate(tabPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only: initial directory load

  useEffect(() => {
    if (tabPath && tabPath !== currentPath) {
      navigate(tabPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabPath]); // reacts to external navigation (bookmarks); navigate is stable

  // Directory auto-watch: refresh when the current directory changes on disk
  //
  // 貼り付け・削除などでは短時間に大量の変更通知が届く。通知ごとに read_dir と
  // 再描画を行うと UI が固まるため、再読込は「必要になったタイミング」に絞る:
  //   - 直近の再読込から REFRESH_MIN_INTERVAL_MS 以内の通知はまとめて 1 回にする
  //   - ウィンドウが非表示の間は再読込せず、表示に戻ったときにまとめて反映する
  useEffect(() => {
    if (!currentPath) return;
    invoke("watch_dir", { path: currentPath }).catch(() => {});

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = 0;
    let deferred = false; // 非表示中に届いた通知を保留中か

    const runRefresh = () => {
      timer = null;
      if (disposed) return;
      if (document.hidden) {
        deferred = true; // 見えていない間は描画しない（表示に戻ったときに反映）
        return;
      }
      deferred = false;
      lastRefreshAt = Date.now();
      navigate(currentPath, false, true); // silent: FS refresh, don't steal active pane
      window.dispatchEvent(new CustomEvent(APP_EVENTS.FS_DIR_CHANGED, { detail: { path: currentPath } }));
    };

    // 先頭の通知は即時に反映し、以降のバーストは最短間隔まで間引く
    const scheduleRefresh = () => {
      if (timer) return;
      const wait = Math.max(0, REFRESH_MIN_INTERVAL_MS - (Date.now() - lastRefreshAt));
      timer = setTimeout(runRefresh, wait);
    };

    const onVisibilityChange = () => {
      if (!document.hidden && deferred) scheduleRefresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const unlisten = listen<{ path: string }>("fs:changed", (event) => {
      if (event.payload.path === currentPath) scheduleRefresh();
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      invoke("unwatch_dir", { path: currentPath }).catch(() => {});
      unlisten.then((fn) => fn());
    };
  }, [currentPath, navigate]);

  const canGoBack = historyIndexRef.current > 0;
  const canGoForward = historyIndexRef.current < historyRef.current.length - 1;

  return {
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
  };
}
