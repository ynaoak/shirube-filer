import { lazy, Suspense, useEffect, useState } from "react";
import i18n from "../../i18n";
import { PaneNode, Tab, TerminalTab } from "../../types/layout";
import { useLayout, genId } from "../../store/layoutStore";
import { tabDnd } from "../../lib/tabDnd";
import { APP_EVENTS } from "../../lib/appEvents";
import TabBar from "./TabBar";
import FileList from "../fileList/FileList";
import TrashBrowser from "../viewers/TrashBrowser";
import PreviewPanel from "../panels/PreviewPanel";
import { HAS_TERMINAL } from "../../buildConfig";

// xterm を含む Terminal は重く、ターミナルタブを開いたときだけ必要なので遅延ロードする。
const Terminal = lazy(() => import("../viewers/Terminal"));

type Props = {
  pane: PaneNode;
  onSelectFile: (path: string | null) => void;
};

export default function PaneContainer({ pane, onSelectFile }: Props) {
  const { dispatch, setActivePaneId, setActiveTreePath, previewPaneId, setPreviewPaneId, previewFilePath } = useLayout();
  const [isDragTarget, setIsDragTarget] = useState(false);

  // Clear drag target highlight on pointer release anywhere
  useEffect(() => {
    const onUp = () => setIsDragTarget(false);
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, []);

  // OSC 7: terminal CWD change → update file tab path in same pane
  useEffect(() => {
    const handler = (e: Event) => {
      const { terminalId, cwd } = (e as CustomEvent).detail as { terminalId: string; cwd: string };
      const terminalTab = pane.tabs.find(
        (t) => t.paneType === "terminal" && t.terminalId === terminalId
      );
      if (!terminalTab) return;
      const fileTab = pane.tabs.find((t) => t.paneType === "file");
      if (fileTab) {
        dispatch({ type: "UPDATE_TAB", paneId: pane.id, tabId: fileTab.id, patch: { path: cwd } });
      }
      dispatch({ type: "UPDATE_TAB", paneId: pane.id, tabId: terminalTab.id, patch: { cwd } });
    };
    window.addEventListener(APP_EVENTS.TERMINAL_CWD, handler);
    return () => window.removeEventListener(APP_EVENTS.TERMINAL_CWD, handler);
  }, [pane.tabs, pane.id, dispatch]);

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);

  const addFileTab = () => {
    dispatch({
      type: "ADD_TAB",
      paneId: pane.id,
      tab: { id: genId(), paneType: "file", title: "Home", path: "", history: [], historyIndex: 0 },
    });
  };

  const openInTerminal = () => {
    const currentPath = activeTab?.paneType === "file" ? activeTab.path : "";
    dispatch({
      type: "SPLIT_PANE",
      paneId: pane.id,
      direction: "vertical",
      initialTab: { id: genId(), paneType: "terminal", title: "Terminal", cwd: currentPath, terminalId: genId() },
    });
  };

  const cloneTab = (tab: Tab) => {
    const cloned: Tab = tab.paneType === "file"
      ? { ...tab, id: genId(), title: i18n.t("tabBar.copySuffix", { title: tab.title }), pinned: false }
      : tab.paneType === "trash"
      ? { ...tab, id: genId(), pinned: false }
      : { ...tab, id: genId(), terminalId: genId(), pinned: false };
    dispatch({ type: "ADD_TAB", paneId: pane.id, tab: cloned });
  };

  // このペインがプレビューペインの場合は PreviewPanel をフルで表示
  if (pane.id === previewPaneId) {
    return (
      <div
        data-pane-id={pane.id}
        className="flex flex-col w-full h-full min-w-0 overflow-hidden border"
        style={{ borderColor: "var(--kf-border)" }}
      >
        <PreviewPanel
          fill
          filePath={previewFilePath}
          onClose={() => {
            setPreviewPaneId(null);
            dispatch({ type: "CLOSE_PANE", paneId: pane.id });
          }}
        />
      </div>
    );
  }

  return (
    <div
      data-pane-id={pane.id}
      className="flex flex-col w-full h-full min-w-0 overflow-hidden border"
      style={{
        borderColor: isDragTarget ? "var(--kf-accent)" : "var(--kf-border)",
        transition: "border-color 0.1s",
      }}
      onFocus={() => {
        setActivePaneId(pane.id);
        // Clear direct path so activePaneId-based fallback takes over for this pane
        const tab = activeTab;
        setActiveTreePath(tab?.paneType === "file" && tab.path ? tab.path : "");
      }}
      onPointerEnter={() => {
        if (tabDnd.current && tabDnd.current.sourcePaneId !== pane.id) {
          setIsDragTarget(true);
        }
      }}
      onPointerLeave={(e) => {
        if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragTarget(false);
        }
      }}
    >
      <TabBar
        pane={pane}
        onAddFileTab={addFileTab}
        onOpenInTerminal={HAS_TERMINAL && activeTab?.paneType !== "terminal" ? openInTerminal : undefined}
        onSplitHorizontal={() => {
          dispatch({ type: "SPLIT_PANE", paneId: pane.id, direction: "horizontal" });
        }}
        onSplitVertical={() => {
          dispatch({ type: "SPLIT_PANE", paneId: pane.id, direction: "vertical" });
        }}
        onClosePane={() => dispatch({ type: "CLOSE_PANE", paneId: pane.id })}
        onCloneTab={cloneTab}
      />
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden relative">
        {activeTab?.paneType === "file" && (
          <div className="h-full overflow-x-auto">
            {/* ツールバー・チップ行は縮退可能になったため、床は「一覧が意味を保てる」
                最小幅まで下げる。3〜4 分割の通常幅（約 330px〜）では横スクロールに
                ならず全 UI が収まり、それ未満の極端な狭さでのみスクロールに退避する */}
            <div style={{ minWidth: 280, height: "100%" }}>
              <FileList key={activeTab.id} paneId={pane.id} tab={activeTab} onSelectFile={onSelectFile} />
            </div>
          </div>
        )}
        {activeTab?.paneType === "trash" && <TrashBrowser />}
        {/* ターミナルタブは PTY セッション・履歴を維持するため常時マウントし、
            非アクティブ時は display:none で隠す。Store ビルドでは PTY 無効のためスキップ。 */}
        {HAS_TERMINAL && pane.tabs.filter((t) => t.paneType === "terminal").map((t) => {
          const isActive = t.id === pane.activeTabId;
          return (
            <div
              key={t.id}
              style={{ display: isActive ? "block" : "none", width: "100%", height: "100%" }}
            >
              <Suspense fallback={null}>
                <Terminal tab={t as TerminalTab} isActive={isActive} />
              </Suspense>
            </div>
          );
        })}
      </div>
    </div>
  );
}
