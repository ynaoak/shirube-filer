import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../common/Icon";
import { APP_EVENTS } from "../../lib/appEvents";
import { useColorLabels } from "../../store/colorLabelStore";
import { COLOR_LABEL_COLORS, COLOR_LABEL_NAMES } from "../../hooks/useFileFilter";

const MIN_WIDTH = 140;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 208; // w-52

const RECENT_KEY = "kf-recent-paths";
const SAVED_QUERIES_KEY = "kf-saved-queries";
const MAX_RECENT = 20;
const MAX_SHOW_RECENT = 10;

type SavedQuery = { name: string; query: string };

type Bookmark = {
  name: string;
  path: string;
  group?: string;
};


type Props = {
  currentPath: string;
  onNavigate: (path: string) => void;
  /** When true, hides the header and resize handle — width is controlled by parent. */
  controlled?: boolean;
};

export default function BookmarkPanel({ currentPath, onNavigate, controlled = false }: Props) {
  const { t } = useTranslation();
  const DEFAULT_GROUP = t("bookmark.defaultGroup");
  const [width, setWidth] = useState<number>(() => {
    const saved = localStorage.getItem("kf-bookmark-panel-width");
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return isNaN(parsed) ? DEFAULT_WIDTH : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
  });
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const dragStartXRef = useRef<number | null>(null);
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartXRef.current = e.clientX;
    const startWidth = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      if (dragStartXRef.current === null) return;
      const delta = ev.clientX - dragStartXRef.current; // drag right = increase width
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(newWidth);
      localStorage.setItem("kf-bookmark-panel-width", String(newWidth));
    };
    const onUp = () => {
      dragStartXRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); }
    catch { return []; }
  });
  const [recentCollapsed, setRecentCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragItem, setDragItem] = useState<{ path: string; group: string } | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [dragOverItem, setDragOverItem] = useState<{ group: string; index: number } | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const savingRef = useRef(false);

  // ── ラベル付きファイル/フォルダ ─────────────────────────────────────
  const { colorLabels, setColorLabel } = useColorLabels();
  const [labelsCollapsed, setLabelsCollapsed] = useState(false);
  const [labelColorFilter, setLabelColorFilter] = useState<string | null>(null);
  // ラベルはパスと色しか持たないため、フォルダかどうか / まだ存在するかは
  // メタデータを引いて補う（消したファイルのラベルが残ることがあるため）。
  const [labelKinds, setLabelKinds] = useState<Record<string, "dir" | "file" | "missing">>({});

  const labeledPaths = useMemo(
    () => Object.keys(colorLabels).sort((a, b) =>
      (a.split(/[\\/]/).pop() ?? a).localeCompare(b.split(/[\\/]/).pop() ?? b)
    ),
    [colorLabels]
  );

  useEffect(() => {
    if (labelsCollapsed || labeledPaths.length === 0) return;
    let cancelled = false;
    // 未判定のパスだけ問い合わせる（ラベルを1つ足すたびに全件引き直さない）。
    const unknown = labeledPaths.filter((p) => !(p in labelKinds));
    if (unknown.length === 0) return;
    Promise.all(
      unknown.map((p) =>
        invoke<{ isDir: boolean }>("get_file_metadata", { path: p })
          .then((m) => [p, m.isDir ? "dir" : "file"] as const)
          .catch(() => [p, "missing"] as const)
      )
    ).then((pairs) => {
      if (cancelled) return;
      setLabelKinds((prev) => {
        const next = { ...prev };
        for (const [p, kind] of pairs) next[p] = kind;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [labeledPaths, labelsCollapsed, labelKinds]);

  const visibleLabeled = labelColorFilter
    ? labeledPaths.filter((p) => colorLabels[p] === labelColorFilter)
    : labeledPaths;

  /** ラベル項目を開く。フォルダはそのまま移動、ファイルは親を開いて選択する。 */
  const openLabeled = (path: string) => {
    if (labelKinds[path] === "dir") {
      onNavigate(path);
      return;
    }
    window.dispatchEvent(new CustomEvent(APP_EVENTS.REVEAL_PATH, { detail: { path } }));
  };

  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => {
    try { return JSON.parse(localStorage.getItem(SAVED_QUERIES_KEY) ?? "[]"); }
    catch { return []; }
  });
  const [queriesCollapsed, setQueriesCollapsed] = useState(false);
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [savingQueryName, setSavingQueryName] = useState("");
  const [showSaveQueryInput, setShowSaveQueryInput] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const { query } = (e as CustomEvent).detail as { query: string };
      setLastSearchQuery(query);
    };
    window.addEventListener(APP_EVENTS.SEARCH_CHANGED, handler);
    return () => window.removeEventListener(APP_EVENTS.SEARCH_CHANGED, handler);
  }, []);

  const saveQuery = () => {
    const name = savingQueryName.trim() || lastSearchQuery;
    if (!name || !lastSearchQuery) return;
    const next = [...savedQueries.filter((q) => q.query !== lastSearchQuery), { name, query: lastSearchQuery }];
    setSavedQueries(next);
    localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(next));
    setSavingQueryName("");
    setShowSaveQueryInput(false);
  };

  const removeQuery = (query: string) => {
    const next = savedQueries.filter((q) => q.query !== query);
    setSavedQueries(next);
    localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(next));
  };

  const applyQuery = (query: string) => {
    window.dispatchEvent(new CustomEvent(APP_EVENTS.APPLY_SAVED_QUERY, { detail: { query } }));
  };

  useEffect(() => {
    const reload = () => {
      invoke<Bookmark[]>("load_bookmarks")
        .then(setBookmarks)
        .catch((e) => setError(String(e)));
    };
    reload();
    // Reload when a favorite is added from the context menu or a keybinding.
    window.addEventListener(APP_EVENTS.BOOKMARKS_CHANGED, reload);
    return () => window.removeEventListener(APP_EVENTS.BOOKMARKS_CHANGED, reload);
  }, []);

  // Track recently visited directories
  useEffect(() => {
    if (!currentPath) return;
    setRecentPaths((prev) => {
      const next = [currentPath, ...prev.filter((p) => p !== currentPath)].slice(0, MAX_RECENT);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, [currentPath]);

  const save = async (list: Bookmark[]) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await invoke("save_bookmarks", { bookmarks: list });
      setBookmarks(list);
    } catch (e) {
      setError(String(e));
    } finally {
      savingRef.current = false;
    }
  };

  const addCurrent = () => {
    if (!currentPath) return;
    const name = currentPath.split(/[\\/]/).pop() || currentPath;
    if (bookmarks.some((b) => b.path === currentPath)) return;
    save([...bookmarks, { name, path: currentPath }]);
  };

  const remove = (path: string) => save(bookmarks.filter((b) => b.path !== path));

  const bookmarkGroups = Array.from(new Set(bookmarks.map((b) => b.group ?? DEFAULT_GROUP)));
  const groups = [...bookmarkGroups, ...extraGroups.filter((g) => !bookmarkGroups.includes(g))];
  if (groups.length === 0) groups.push(DEFAULT_GROUP);

  const toggleGroup = (g: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      return next;
    });

  const commitAddGroup = () => {
    const name = newGroupName.trim();
    setAddingGroup(false);
    setNewGroupName("");
    if (!name) return;
    const allGroups = [
      ...Array.from(new Set(bookmarks.map((b) => b.group ?? DEFAULT_GROUP))),
      ...extraGroups,
    ];
    if (!allGroups.includes(name)) {
      setExtraGroups((prev) => [...prev, name]);
    }
  };

  const renameGroupStart = (g: string) => {
    setRenamingGroup(g);
    setRenameValue(g);
  };

  const renameGroupCommit = () => {
    const newName = renameValue.trim();
    if (!newName || !renamingGroup || newName === renamingGroup) {
      setRenamingGroup(null);
      return;
    }
    save(bookmarks.map((b) => {
      const bg = b.group ?? DEFAULT_GROUP;
      return bg === renamingGroup ? { ...b, group: newName === DEFAULT_GROUP ? undefined : newName } : b;
    }));
    setExtraGroups((prev) => prev.map((g) => (g === renamingGroup ? newName : g)));
    setRenamingGroup(null);
  };

  const deleteGroup = (g: string) => {
    if (!confirm(t("bookmark.confirmDeleteGroup", { group: g }))) return;
    save(bookmarks.filter((b) => (b.group ?? DEFAULT_GROUP) !== g));
    setExtraGroups((prev) => prev.filter((eg) => eg !== g));
  };

  // Drag & drop: move bookmark to another group or reorder within same group
  const onGroupDragOver = (e: React.DragEvent, g: string) => {
    e.preventDefault();
    setDragOverGroup(g);
  };

  const onItemDragOver = (e: React.DragEvent, g: string, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverGroup(null);
    setDragOverItem({ group: g, index });
  };

  const onDrop = (e: React.DragEvent, targetGroup: string, targetIndex?: number) => {
    e.preventDefault();
    setDragOverGroup(null);
    setDragOverItem(null);
    if (!dragItem) return;

    const isSameGroup = dragItem.group === targetGroup;

    if (isSameGroup && targetIndex !== undefined) {
      // Reorder within same group
      const groupItems = bookmarks.filter((b) => (b.group ?? DEFAULT_GROUP) === targetGroup);
      const otherItems = bookmarks.filter((b) => (b.group ?? DEFAULT_GROUP) !== targetGroup);
      const srcIndex = groupItems.findIndex((b) => b.path === dragItem.path);
      if (srcIndex === -1 || srcIndex === targetIndex) { setDragItem(null); return; }
      const reordered = [...groupItems];
      const [moved] = reordered.splice(srcIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      save([...otherItems, ...reordered]);
    } else {
      // Move to another group
      save(bookmarks.map((b) =>
        b.path === dragItem.path ? { ...b, group: targetGroup === DEFAULT_GROUP ? undefined : targetGroup } : b
      ));
    }
    setDragItem(null);
  };

  return (
    <div
      className={controlled ? "flex flex-col flex-1 text-xs overflow-hidden" : "flex-shrink-0 flex flex-col border-r text-xs overflow-hidden relative"}
      style={controlled ? {
        backgroundColor: "var(--kf-bg-primary)",
        color: "var(--kf-text-primary)",
      } : {
        width,
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* リサイズハンドル — hidden in controlled mode */}
      {!controlled && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500 hover:opacity-60"
          style={{ touchAction: "none" }}
          onMouseDown={handleDragStart}
        />
      )}
      {/* ヘッダー — hidden in controlled mode; actions shown inline */}
      {!controlled ? (
        <div
          className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          <Icon name="bookmarks" size={14} style={{ color: "var(--kf-text-muted)" }} />
          <span className="flex-1 font-semibold" style={{ color: "var(--kf-text-primary)" }}>
            {t("bookmarkPanel.title")}
          </span>
          <button onClick={addCurrent} title={t("bookmark.addCurrentDir")} className="flex items-center" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="add" size={14} />
          </button>
          <button onClick={() => { setAddingGroup(true); setNewGroupName(""); }} title={t("bookmark.addGroup")} className="flex items-center" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="create_new_folder" size={14} />
          </button>
        </div>
      ) : (
        <div
          className="flex items-center gap-1 px-2 py-1 border-b shrink-0"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <span className="flex-1 text-xs font-semibold" style={{ color: "var(--kf-text-muted)" }}>{t("bookmarkPanel.title")}</span>
          <button onClick={addCurrent} title={t("bookmark.addCurrentDir")} className="flex items-center opacity-60 hover:opacity-100" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="add" size={13} />
          </button>
          <button onClick={() => { setAddingGroup(true); setNewGroupName(""); }} title={t("bookmark.addGroup")} className="flex items-center opacity-60 hover:opacity-100" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="create_new_folder" size={13} />
          </button>
        </div>
      )}

      {addingGroup && (
        <div className="flex items-center gap-1 px-3 py-1 border-b" style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}>
          <Icon name="create_new_folder" size={12} style={{ color: "var(--kf-text-muted)" }} />
          <input
            autoFocus
            className="flex-1 bg-transparent outline-none text-xs"
            style={{ borderBottom: "1px solid var(--kf-accent)", color: "var(--kf-text-primary)" }}
            placeholder={t("bookmark.groupNamePlaceholder")}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitAddGroup();
              if (e.key === "Escape") { setAddingGroup(false); setNewGroupName(""); }
            }}
            onBlur={commitAddGroup}
          />
        </div>
      )}

      {error && (
        <div className="px-3 py-1 text-red-400 flex items-center gap-1">
          <Icon name="error" size={12} />{error}
        </div>
      )}

      {/* グループ別ブックマーク */}
      <div className="flex-1 overflow-y-auto">

        {/* 最近開いたフォルダ */}
        {recentPaths.length > 0 && (
          <div>
            <div
              className="flex items-center gap-1 px-2 py-0.5 cursor-pointer"
              style={{ backgroundColor: "var(--kf-bg-secondary)", borderBottom: "1px solid var(--kf-border-soft)" }}
              onClick={() => setRecentCollapsed((v) => !v)}
            >
              <Icon
                name={recentCollapsed ? "chevron_right" : "expand_more"}
                size={13}
                style={{ color: "var(--kf-text-muted)" }}
              />
              <Icon name="history" size={12} style={{ color: "var(--kf-text-muted)", marginRight: 2 }} />
              <span className="flex-1 truncate font-semibold" style={{ color: "var(--kf-text-secondary)" }}>
                {t("bookmarkPanel.recent")}
              </span>
              <span className="text-[10px] opacity-50">{Math.min(recentPaths.length, MAX_SHOW_RECENT)}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  localStorage.setItem(RECENT_KEY, "[]");
                  setRecentPaths([]);
                }}
                className="opacity-0 hover:opacity-100 flex items-center"
                style={{ color: "var(--kf-text-muted)" }}
                title={t("bookmark.clearHistory")}
              >
                <Icon name="delete_sweep" size={12} />
              </button>
            </div>
            {!recentCollapsed && recentPaths.slice(0, MAX_SHOW_RECENT).map((p) => (
              <div
                key={p}
                className="flex items-center gap-1.5 px-3 py-1 cursor-pointer group"
                style={{ color: "var(--kf-text-primary)" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                onClick={() => onNavigate(p)}
                title={p}
              >
                <Icon name="folder_open" size={13} style={{ color: "var(--kf-text-muted)", flexShrink: 0 }} />
                <span className="flex-1 truncate text-xs">{p.split(/[\\/]/).pop() || p}</span>
                <button
                  className="opacity-0 group-hover:opacity-100 flex items-center"
                  style={{ color: "var(--kf-text-muted)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRecentPaths((prev) => {
                      const next = prev.filter((x) => x !== p);
                      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
                      return next;
                    });
                  }}
                  title={t("bookmark.removeFromHistory")}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {groups.map((g) => {
          const items = bookmarks.filter((b) => (b.group ?? DEFAULT_GROUP) === g);
          const collapsed = collapsedGroups.has(g);
          const isDragTarget = dragOverGroup === g;
          return (
            <div
              key={g}
              onDragOver={(e) => onGroupDragOver(e, g)}
              onDragLeave={() => setDragOverGroup(null)}
              onDrop={(e) => onDrop(e, g)}
              style={{ backgroundColor: isDragTarget ? "var(--kf-bg-tertiary)" : undefined }}
            >
              {/* グループヘッダー */}
              <div
                className="flex items-center gap-1 px-2 py-0.5 cursor-pointer group"
                style={{
                  backgroundColor: "var(--kf-bg-secondary)",
                  borderBottom: "1px solid var(--kf-border-soft)",
                }}
                onClick={() => toggleGroup(g)}
              >
                <Icon name={collapsed ? "chevron_right" : "expand_more"} size={13} style={{ color: "var(--kf-text-muted)" }} />
                {renamingGroup === g ? (
                  <input
                    className="flex-1 bg-transparent outline-none text-xs"
                    style={{ borderBottom: "1px solid var(--kf-accent)", color: "var(--kf-text-primary)" }}
                    value={renameValue}
                    autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") renameGroupCommit(); if (e.key === "Escape") setRenamingGroup(null); }}
                    onBlur={renameGroupCommit}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="flex-1 truncate font-semibold" style={{ color: "var(--kf-text-secondary)" }}>{g}</span>
                )}
                <span className="text-[10px] opacity-50">{items.length}</span>
                {/* Group actions */}
                <div className="hidden group-hover:flex items-center gap-0.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); renameGroupStart(g); }}
                    className="flex items-center opacity-60 hover:opacity-100"
                    title={t("bookmark.renameGroup")}
                  >
                    <Icon name="edit" size={11} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteGroup(g); }}
                    className="flex items-center opacity-60 hover:opacity-100"
                    title={t("bookmark.deleteGroup")}
                    style={{ color: "var(--kf-error)" }}
                  >
                    <Icon name="delete" size={11} />
                  </button>
                </div>
              </div>

              {/* アイテム */}
              {!collapsed && (
                <>
                  {items.length === 0 && (
                    <div className="px-6 py-1 text-[10px]" style={{ color: "var(--kf-text-muted)" }}>
                      {t("bookmarkPanel.emptyGroup")}
                    </div>
                  )}
                  {items.map((b, idx) => {
                    const isDropTarget = dragOverItem?.group === g && dragOverItem.index === idx;
                    return (
                    <div
                      key={b.path}
                      className="flex items-center gap-1.5 px-3 py-1 cursor-pointer transition-colors group"
                      style={{
                        color: "var(--kf-text-primary)",
                        borderTop: isDropTarget ? "2px solid var(--kf-accent)" : "2px solid transparent",
                      }}
                      draggable
                      onDragStart={() => setDragItem({ path: b.path, group: g })}
                      onDragEnd={() => { setDragItem(null); setDragOverItem(null); }}
                      onDragOver={(e) => onItemDragOver(e, g, idx)}
                      onDrop={(e) => onDrop(e, g, idx)}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                      onClick={() => onNavigate(b.path)}
                      title={b.path}
                    >
                      <Icon name="folder" size={13} style={{ color: "var(--kf-accent)", flexShrink: 0 }} />
                      <span className="flex-1 truncate text-xs">{b.name}</span>
                      <button
                        className="opacity-0 group-hover:opacity-100 flex items-center"
                        style={{ color: "var(--kf-text-muted)" }}
                        onClick={(e) => { e.stopPropagation(); remove(b.path); }}
                        title={t("bookmark.deleteBookmark")}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
        {bookmarks.length === 0 && groups.length <= 1 && (
          <div className="flex flex-col items-center justify-center h-16 gap-1" style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="bookmark_add" size={18} />
            <span>{t("bookmarkPanel.addHint")}</span>
          </div>
        )}

        {/* ラベル付きの項目 */}
        <div className="border-t shrink-0" style={{ borderColor: "var(--kf-border)" }}>
          <div
            className="flex items-center gap-1 px-2 py-0.5 cursor-pointer select-none"
            style={{ backgroundColor: "var(--kf-bg-secondary)", borderBottom: "1px solid var(--kf-border-soft)" }}
            onClick={() => setLabelsCollapsed((v) => !v)}
          >
            <Icon name={labelsCollapsed ? "chevron_right" : "expand_more"} size={13} style={{ color: "var(--kf-text-muted)" }} />
            <Icon name="label" size={12} style={{ color: "var(--kf-text-muted)", marginRight: 2 }} />
            <span className="flex-1 truncate font-semibold" style={{ color: "var(--kf-text-secondary)" }}>
              {t("bookmarkPanel.labels")}
            </span>
            <span className="text-[10px] opacity-50">{visibleLabeled.length}</span>
          </div>

          {!labelsCollapsed && (
            <>
              {labeledPaths.length === 0 ? (
                <div className="px-6 py-1 text-[10px]" style={{ color: "var(--kf-text-muted)" }}>
                  {t("bookmarkPanel.noLabels")}
                </div>
              ) : (
                <>
                  {/* 色で絞り込む。使われている色だけ出し、同じ色をもう一度押すと解除。 */}
                  <div className="flex items-center gap-1 px-3 py-1 flex-wrap">
                    {COLOR_LABEL_COLORS.filter((c) => labeledPaths.some((p) => colorLabels[p] === c)).map((color) => {
                      const idx = COLOR_LABEL_COLORS.indexOf(color);
                      const active = labelColorFilter === color;
                      return (
                        <button
                          key={color}
                          onClick={() => setLabelColorFilter(active ? null : color)}
                          title={t("fileList.filterByLabel", { label: t(COLOR_LABEL_NAMES[idx]) })}
                          aria-pressed={active}
                          data-label-color={color}
                          data-label-scope="bookmark"
                          className="flex items-center justify-center rounded-full shrink-0"
                          style={{
                            width: 18,
                            height: 18,
                            border: active ? "2px solid var(--kf-accent)" : "1px solid var(--kf-border-soft)",
                          }}
                        >
                          <span style={{ width: 9, height: 9, borderRadius: "50%", backgroundColor: color, display: "block" }} />
                        </button>
                      );
                    })}
                    {labelColorFilter && (
                      <button
                        onClick={() => setLabelColorFilter(null)}
                        className="text-[10px] px-1 opacity-60 hover:opacity-100"
                        style={{ color: "var(--kf-text-muted)" }}
                      >
                        {t("bookmarkPanel.clearLabelFilter")}
                      </button>
                    )}
                  </div>

                  {visibleLabeled.map((p) => {
                    const kind = labelKinds[p];
                    const missing = kind === "missing";
                    return (
                      <div
                        key={p}
                        className="flex items-center gap-1.5 px-3 py-1 cursor-pointer group"
                        style={{ color: "var(--kf-text-primary)", opacity: missing ? 0.45 : 1 }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                        onClick={() => { if (!missing) openLabeled(p); }}
                        title={missing ? t("bookmarkPanel.labelMissing", { path: p }) : p}
                      >
                        <span
                          style={{
                            width: 8, height: 8, borderRadius: "50%",
                            backgroundColor: colorLabels[p], flexShrink: 0, display: "block",
                          }}
                        />
                        <Icon
                          name={missing ? "help" : kind === "dir" ? "folder" : "description"}
                          size={13}
                          style={{ color: "var(--kf-text-muted)", flexShrink: 0 }}
                        />
                        <span className="flex-1 truncate text-xs">{p.split(/[\\/]/).pop() || p}</span>
                        <button
                          className="opacity-0 group-hover:opacity-100 flex items-center"
                          style={{ color: "var(--kf-text-muted)" }}
                          onClick={(e) => { e.stopPropagation(); setColorLabel([p], null); }}
                          title={t("bookmarkPanel.removeLabel")}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    );
                  })}
                  {visibleLabeled.length === 0 && (
                    <div className="px-6 py-1 text-[10px]" style={{ color: "var(--kf-text-muted)" }}>
                      {t("bookmarkPanel.noLabelsForColor")}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* 保存済み検索クエリ */}
        <div className="border-t shrink-0" style={{ borderColor: "var(--kf-border)" }}>
          <div
            className="flex items-center gap-1 px-3 py-1.5 cursor-pointer select-none"
            style={{ backgroundColor: "var(--kf-bg-secondary)", color: "var(--kf-text-secondary)" }}
            onClick={() => setQueriesCollapsed((v) => !v)}
          >
            <Icon name={queriesCollapsed ? "chevron_right" : "expand_more"} size={13} />
            <Icon name="manage_search" size={13} style={{ color: "var(--kf-text-muted)" }} />
            <span className="flex-1 text-[10px] font-semibold">{t("bookmarkPanel.savedSearches")}</span>
            {lastSearchQuery && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowSaveQueryInput((v) => !v); setSavingQueryName(""); }}
                title={t("bookmark.saveSearchQuery")}
                className="opacity-60 hover:opacity-100 flex items-center"
              >
                <Icon name="bookmark_add" size={13} />
              </button>
            )}
          </div>

          {showSaveQueryInput && (
            <div
              className="flex items-center gap-1 px-3 py-1 border-b"
              style={{ backgroundColor: "var(--kf-bg-tertiary)", borderColor: "var(--kf-border)" }}
            >
              <input
                autoFocus
                className="flex-1 px-1 py-0.5 rounded border text-[10px]"
                style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
                placeholder={lastSearchQuery}
                value={savingQueryName}
                onChange={(e) => setSavingQueryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); saveQuery(); }
                  if (e.key === "Escape") { setShowSaveQueryInput(false); }
                }}
              />
              <button
                onClick={saveQuery}
                className="flex items-center"
                style={{ color: "var(--kf-accent)" }}
                title={t("bookmark.save")}
              >
                <Icon name="check" size={13} />
              </button>
            </div>
          )}

          {!queriesCollapsed && (
            <>
              {savedQueries.length === 0 && (
                <div className="px-6 py-1 text-[10px]" style={{ color: "var(--kf-text-muted)" }}>
                  {lastSearchQuery ? t("bookmark.saveSearchHint") : t("bookmark.noSearchQuery")}
                </div>
              )}
              {savedQueries.map((sq) => (
                <div
                  key={sq.query}
                  className="flex items-center gap-1.5 px-3 py-1 cursor-pointer transition-colors group"
                  style={{ color: "var(--kf-text-primary)" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = ""; }}
                  onClick={() => applyQuery(sq.query)}
                  title={sq.query}
                >
                  <Icon name="search" size={13} style={{ color: "var(--kf-text-muted)", flexShrink: 0 }} />
                  <span className="flex-1 truncate text-xs">{sq.name}</span>
                  <span className="text-[9px] truncate max-w-[60px]" style={{ color: "var(--kf-text-muted)" }}>{sq.query}</span>
                  <button
                    className="opacity-0 group-hover:opacity-100 flex items-center"
                    style={{ color: "var(--kf-text-muted)" }}
                    onClick={(e) => { e.stopPropagation(); removeQuery(sq.query); }}
                    title={t("bookmark.delete")}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
