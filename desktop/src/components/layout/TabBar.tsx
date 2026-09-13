import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PaneNode, Tab } from "../../types/layout";
import { useLayout, countAllTabs } from "../../store/layoutStore";
import { tabDnd } from "../../lib/tabDnd";
import { createDragGhost, DragGhost } from "../../lib/dragGhost";
import { useMenuClamp } from "../../hooks/useMenuClamp";
import { formatModCombo } from "../../store/keybindingStore";
import {
  handleExternalTabDrop,
  isChildWindow,
  createCrossWindowDragNotifier,
  CrossWindowDragNotifier,
} from "../../lib/tearoff";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Icon from "../common/Icon";
import TerminalIcon from "../viewers/TerminalIcon";
import { HAS_TERMINAL } from "../../buildConfig";

type Props = {
  pane: PaneNode;
  onAddFileTab: () => void;
  onOpenInTerminal: (() => void) | undefined;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClosePane: () => void;
  onCloneTab: (tab: Tab) => void;
};

export default function TabBar({
  pane,
  onAddFileTab,
  onOpenInTerminal,
  onSplitHorizontal,
  onSplitVertical,
  onClosePane,
  onCloneTab,
}: Props) {
  const { t } = useTranslation();
  const { dispatch, setActiveTreePath, layout } = useLayout();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [dragOverAddBtn, setDragOverAddBtn] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const { ref: tabMenuRef, pos: tabMenuPos } = useMenuClamp(tabMenu?.x ?? 0, tabMenu?.y ?? 0);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!tabMenu) return;
    function onDown(e: MouseEvent) {
      if (tabMenuRef.current && !tabMenuRef.current.contains(e.target as Node)) {
        setTabMenu(null);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [tabMenu]);

  // Clear reorder indicator on pointer release
  useEffect(() => {
    const onUp = () => {
      setDragOverTabId(null);
      setDragOverAddBtn(false);
    };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, []);

  return (
    <div className="flex flex-col shrink-0">
      {/* タブバー（ブラウザ風: 非アクティブはフラット、アクティブはコンテンツに連続） */}
      <div
        className="flex items-end min-h-8 shrink-0"
        style={{
          backgroundColor: "var(--kf-bg-secondary)",
          borderBottom: "1px solid var(--kf-border)",
        }}
      >
        {/* タブ一覧 + 追加ボタン */}
        <div className="flex flex-wrap flex-1 items-center">
          {(() => {
            const titleCount: Record<string, number> = {};
            const titleIndex: Record<string, number> = {};
            for (const t of pane.tabs) {
              titleCount[t.title] = (titleCount[t.title] ?? 0) + 1;
            }
            return pane.tabs.map((tab) => {
              const isActive = tab.id === pane.activeTabId;
              let displayTitle = tab.title;
              if (titleCount[tab.title] > 1) {
                titleIndex[tab.title] = (titleIndex[tab.title] ?? 0) + 1;
                displayTitle = `${tab.title} (${titleIndex[tab.title]})`;
              }
              const isDragTarget = dragOverTabId === tab.id;
              const isPinned = !!tab.pinned;
              return (
                <div
                  key={tab.id}
                  data-tab-id={tab.id}
                  data-pane-id={pane.id}
                  // 狭いペインではアドレスバーを畳むため、現在地の確認手段として
                  // タブのツールチップにフルパスを出す。
                  title={tab.paneType === "file" && tab.path ? tab.path : tab.title}
                  className="group relative flex items-center gap-1.5 px-3 py-1.5 text-xs whitespace-nowrap select-none kf-native-hover"
                  style={{
                    // アクティブタブは body 色と同じにしてコンテンツ領域に「繋がる」見た目を作る。
                    // border-bottom はアクティブ時のみ透明にして連続性を出す。
                    // 非アクティブはバー背景（bg-secondary）と同色だとタブの形が
                    // 判別できない。bg-tertiary に border を混ぜて塗ることで、
                    // dark では明るく・light では暗く、どちらもバー背景から離れる。
                    backgroundColor: isActive
                      ? "var(--kf-bg-primary)"
                      : "color-mix(in srgb, var(--kf-border) 45%, var(--kf-bg-tertiary))",
                    color: isActive ? "var(--kf-text-primary)" : "var(--kf-text-secondary)",
                    borderTop: "1px solid transparent",
                    borderLeft: isDragTarget
                      ? "2px solid var(--kf-accent)"
                      : "1px solid transparent",
                    borderRight: "1px solid transparent",
                    // 非アクティブタブ同士の境界（縦罫線）と、バー背景との境界（上辺）。
                    // 罫線を出すことでタブ 1 枚 1 枚の区切りを明確にする。
                    boxShadow: !isActive
                      ? "inset -1px 0 0 0 var(--kf-border), inset 0 1px 0 0 var(--kf-border)"
                      : "none",
                    // ピン留めは小さな三角ではなく上辺アクセント
                    borderTopColor: isPinned ? "var(--kf-accent)" : "transparent",
                    borderRadius: isActive ? "8px 8px 0 0" : "0",
                    marginRight: 0,
                    marginBottom: -1, // アクティブ時に下罫線を「跨ぐ」
                    // 通常はクリック対象としての pointer。押下〜ドラッグ中は
                    // body.kf-dragging（全要素 grabbing !important）が上書きする
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      // 通常時が既に border 混色のため、ホバーはさらに border 寄りへ
                      // 振って変化を判別できるようにする。
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        "color-mix(in srgb, var(--kf-border) 95%, var(--kf-bg-tertiary))";
                      (e.currentTarget as HTMLElement).style.color =
                        "var(--kf-text-primary)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLElement).style.backgroundColor = "var(--kf-bg-tertiary)";
                      (e.currentTarget as HTMLElement).style.color = "var(--kf-text-secondary)";
                    }
                  }}
                  onPointerEnter={() => {
                    if (tabDnd.current) setDragOverTabId(tab.id);
                  }}
                  onPointerLeave={() => {
                    setDragOverTabId((prev) => (prev === tab.id ? null : prev));
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    // Don't initiate drag from close button
                    if ((e.target as HTMLElement).closest("button")) return;

                    const tabId = tab.id;
                    const sourcePaneId = pane.id;
                    const tabTitle = tab.title;
                    const startX = e.clientX;
                    const startY = e.clientY;
                    let dragActive = false;
                    // 押下した瞬間から grabbing 表示（cleanup が全終了経路で外す）
                    document.body.classList.add("kf-dragging");
                    let ghost: DragGhost | null = null;
                    // 別ウィンドウの上をドラッグ中、その窓にもゴーストを出すための通知役
                    let crossNotifier: CrossWindowDragNotifier | null = null;

                    // すべての終了経路（up / cancel / blur）で必ず呼ぶ後始末。
                    // pointercancel を取り逃すと pointermove リスナーと kf-dragging が
                    // 永久に残留し、ドラッグの繰り返しでアプリが応答不能になる。
                    const cleanup = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      window.removeEventListener("pointercancel", onCancel);
                      window.removeEventListener("blur", onCancel);
                      document.body.classList.remove("kf-dragging");
                      ghost?.destroy();
                      ghost = null;
                      crossNotifier?.clear();
                      crossNotifier = null;
                      setDragOverTabId(null);
                      tabDnd.current = null;
                    };

                    const onMove = (me: PointerEvent) => {
                      if (!dragActive) {
                        if (
                          Math.abs(me.clientX - startX) > 5 ||
                          Math.abs(me.clientY - startY) > 5
                        ) {
                          dragActive = true;
                          tabDnd.current = { tabId, sourcePaneId };
                          // ドラッグ中の視覚フィードバック: タブ名のゴーストがカーソルに追従
                          ghost = createDragGhost(tabTitle);
                          ghost.move(me.clientX, me.clientY);
                          crossNotifier = createCrossWindowDragNotifier(tabTitle);
                        }
                        return;
                      }
                      ghost?.move(me.clientX, me.clientY);

                      // ウィンドウ外では、カーソル下の別ウィンドウへ over/leave を通知して
                      // 移動先側にもゴーストを表示させる（マウスは移動元がキャプチャ中で、
                      // 移動先の DOM にはポインタイベントが届かないため）。
                      const outside =
                        me.clientX < 0 ||
                        me.clientY < 0 ||
                        me.clientX >= window.innerWidth ||
                        me.clientY >= window.innerHeight;
                      if (outside) crossNotifier?.onMove();
                      else crossNotifier?.clear();
                    };

                    const onCancel = () => cleanup();

                    const onUp = (ue: PointerEvent) => {
                      const wasDragging = dragActive && tabDnd.current !== null;
                      cleanup();
                      if (!wasDragging) return;

                      // ウィンドウの外にドロップした場合は切り離し／別ウィンドウへの統合。
                      const outside =
                        ue.clientX < 0 ||
                        ue.clientY < 0 ||
                        ue.clientX >= window.innerWidth ||
                        ue.clientY >= window.innerHeight;
                      if (outside) {
                        const wasChild = isChildWindow();
                        const totalTabs = layoutRef.current.groups.reduce(
                          (sum, g) => sum + countAllTabs(g.root),
                          0
                        );
                        const draggedTab = tab;
                        void handleExternalTabDrop(draggedTab).then((result) => {
                          if (result === "none") return;
                          // 元からタブを取り除く。子ウィンドウで最後の 1 枚なら窓ごと閉じる。
                          if (wasChild && totalTabs <= 1) {
                            getCurrentWindow().close().catch(() => {});
                          } else {
                            dispatchRef.current({
                              type: "CLOSE_TAB",
                              paneId: sourcePaneId,
                              tabId,
                            });
                          }
                        });
                        return;
                      }

                      const elements = document.elementsFromPoint(ue.clientX, ue.clientY);

                      // Look for a tab drop target first (reorder or cross-pane onto specific tab)
                      const targetTabEl = elements.find(
                        (el) =>
                          el.hasAttribute("data-tab-id") &&
                          el.getAttribute("data-tab-id") !== tabId
                      );

                      if (targetTabEl) {
                        const targetTabId = targetTabEl.getAttribute("data-tab-id")!;
                        const targetPaneId = targetTabEl.getAttribute("data-pane-id")!;

                        if (targetPaneId === sourcePaneId) {
                          // Same pane: reorder
                          dispatchRef.current({
                            type: "REORDER_TAB",
                            paneId: sourcePaneId,
                            tabId,
                            targetTabId,
                          });
                        } else {
                          // Different pane: move
                          dispatchRef.current({
                            type: "MOVE_TAB",
                            tabId,
                            sourcePaneId,
                            targetPaneId: targetPaneId,
                          });
                        }
                      } else {
                        // No tab target — look for a pane container
                        const targetPaneEl = elements.find((el) =>
                          el.hasAttribute("data-pane-id")
                        );
                        if (targetPaneEl) {
                          const targetPaneId = targetPaneEl.getAttribute("data-pane-id")!;
                          if (targetPaneId !== sourcePaneId) {
                            dispatchRef.current({
                              type: "MOVE_TAB",
                              tabId,
                              sourcePaneId,
                              targetPaneId,
                            });
                          }
                        }
                      }
                    };

                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                    window.addEventListener("pointercancel", onCancel);
                    window.addEventListener("blur", onCancel);
                  }}
                  onClick={() => {
                    dispatch({ type: "SET_ACTIVE_TAB", paneId: pane.id, tabId: tab.id });
                    setActiveTreePath(tab.paneType === "file" && tab.path ? tab.path : "");
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabMenu({ x: e.clientX, y: e.clientY, tab });
                  }}
                >
                  {isPinned && <Icon name="push_pin" size={14} style={{ opacity: 0.8 }} />}
                  {tab.paneType === "terminal" ? (
                    <TerminalIcon size={18} />
                  ) : (
                    <Icon
                      name={tab.paneType === "trash" ? "delete" : "folder_open"}
                      size={18}
                      style={{
                        color: isActive ? "var(--kf-accent)" : "var(--kf-text-secondary)",
                        opacity: 1,
                      }}
                    />
                  )}
                  <span>{displayTitle}</span>
                  {!isPinned && (
                    <button
                      className="ml-1 p-1 flex items-center opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (pane.tabs.length > 1) {
                          dispatch({ type: "CLOSE_TAB", paneId: pane.id, tabId: tab.id });
                        } else {
                          onClosePane();
                        }
                      }}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              );
            });
          })()}
          <TabBarButton
            title={t("tabBar.addTab", { key: formatModCombo("T") })}
            onClick={onAddFileTab}
            isDragTarget={dragOverAddBtn}
            onPointerEnter={() => {
              if (tabDnd.current && tabDnd.current.sourcePaneId !== pane.id) {
                setDragOverAddBtn(true);
              }
            }}
            onPointerLeave={() => setDragOverAddBtn(false)}
          >
            <Icon name="add" size={16} />
          </TabBarButton>
        </div>

        {/* アクションボタン */}
        <div className="flex items-center gap-0.5 px-1 shrink-0 self-start" style={{ minHeight: 32 }}>
          {HAS_TERMINAL && onOpenInTerminal && (
            <TabBarButton title={t("tabBar.openInTerminal")} onClick={onOpenInTerminal}>
              <TerminalIcon size={16} />
            </TabBarButton>
          )}
          <TabBarButton title={t("tabBar.splitHorizontal")} onClick={onSplitHorizontal}>
            <Icon name="vertical_split" size={16} />
          </TabBarButton>
          <TabBarButton title={t("tabBar.splitVertical")} onClick={onSplitVertical}>
            <Icon name="horizontal_split" size={16} />
          </TabBarButton>
          <TabBarButton title={t("tabBar.closePane")} onClick={onClosePane}>
            <Icon name="close" size={16} />
          </TabBarButton>
        </div>
      </div>

      {/* タブコンテキストメニュー */}
      {tabMenu && (
        <div
          ref={tabMenuRef}
          className="kf-surface-menu fixed z-50 py-1 text-xs min-w-[160px]"
          style={{ left: tabMenuPos.x, top: tabMenuPos.y, color: "var(--kf-text-primary)" }}
        >
          <button
            className="kf-menu-item flex items-center gap-2 w-full px-2.5 mx-1 text-left"
            onClick={() => {
              dispatch({ type: "TOGGLE_PIN_TAB", paneId: pane.id, tabId: tabMenu.tab.id });
              setTabMenu(null);
            }}
          >
            <Icon name="push_pin" size={13} />
            {tabMenu.tab.pinned ? t("tabBar.unpinTab") : t("tabBar.pinTab")}
          </button>
          <button
            className="kf-menu-item flex items-center gap-2 w-full px-2.5 mx-1 text-left"
            onClick={() => {
              onCloneTab(tabMenu.tab);
              setTabMenu(null);
            }}
          >
            <Icon name="tab_duplicate" size={13} />
            {t("tabBar.cloneTab")}
          </button>
          <div className="my-1 mx-2" style={{ borderTop: "1px solid var(--kf-border-soft)" }} />
          {(() => {
            const idx = pane.tabs.findIndex((t) => t.id === tabMenu.tab.id);
            return (
              <>
                {idx > 0 && (
                  <button
                    className="kf-menu-item flex items-center gap-2 w-full px-2.5 mx-1 text-left"
                    onClick={() => {
                      dispatch({
                        type: "REORDER_TAB",
                        paneId: pane.id,
                        tabId: tabMenu.tab.id,
                        targetTabId: pane.tabs[idx - 1].id,
                      });
                      setTabMenu(null);
                    }}
                  >
                    <Icon name="arrow_back" size={13} />
                    {t("tabBar.moveLeft")}
                  </button>
                )}
                {idx < pane.tabs.length - 1 && (
                  <button
                    className="kf-menu-item flex items-center gap-2 w-full px-2.5 mx-1 text-left"
                    onClick={() => {
                      dispatch({
                        type: "REORDER_TAB",
                        paneId: pane.id,
                        tabId: tabMenu.tab.id,
                        targetTabId: pane.tabs[idx + 1].id,
                      });
                      setTabMenu(null);
                    }}
                  >
                    <Icon name="arrow_forward" size={13} />
                    {t("tabBar.moveRight")}
                  </button>
                )}
              </>
            );
          })()}
          {!tabMenu.tab.pinned && (
            <button
              className="kf-menu-item flex items-center gap-2 w-full px-2.5 mx-1 text-left"
              style={{ color: "var(--kf-error)" }}
              onClick={() => {
                if (pane.tabs.length > 1) {
                  dispatch({ type: "CLOSE_TAB", paneId: pane.id, tabId: tabMenu.tab.id });
                } else {
                  onClosePane();
                }
                setTabMenu(null);
              }}
            >
              <Icon name="close" size={13} />
              {pane.tabs.length > 1 ? t("tabBar.closeTab") : t("tabBar.closePane2")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TabBarButton({
  children,
  title,
  onClick,
  isDragTarget,
  onPointerEnter,
  onPointerLeave,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  isDragTarget?: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="px-1.5 py-0.5 text-xs rounded transition-all flex items-center"
      style={{
        color: isDragTarget ? "var(--kf-accent)" : "var(--kf-text-secondary)",
        opacity: isDragTarget ? 1 : 0.5,
        backgroundColor: isDragTarget ? "var(--kf-accent-muted, color-mix(in srgb, var(--kf-accent) 20%, transparent))" : "transparent",
        outline: isDragTarget ? "2px solid var(--kf-accent)" : "none",
        outlineOffset: "1px",
      }}
    >
      {children}
    </button>
  );
}
