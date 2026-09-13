/**
 * Centralized CustomEvent name constants for cross-component communication.
 * Use these instead of raw string literals to prevent typos and enable
 * IDE navigation / find-usages.
 */
export const APP_EVENTS = {
  /** FileList → other panes: navigate to the same path (sync-nav feature). */
  SYNC_NAV: "kf-sync-nav",
  /** FileList → BookmarkPanel: current search query changed. */
  SEARCH_CHANGED: "kf-search-changed",
  /** BookmarkPanel → FileList: apply a saved search query. */
  APPLY_SAVED_QUERY: "kf-apply-saved-query",
  /** Terminal → PaneContainer: shell reported a new cwd via OSC 7. */
  TERMINAL_CWD: "kf-terminal-cwd",
  /** FileList → FileTreePanel: a directory was refreshed due to an FS change. */
  FS_DIR_CHANGED: "kf-fs-dir-changed",
  /** LayoutRoot → WindowTitleBar: the active folder path changed (drives the title). */
  ACTIVE_PATH: "kf-active-path",
  /** FileList/keybinding → BookmarkPanel: favorites list changed externally; reload. */
  BOOKMARKS_CHANGED: "kf-bookmarks-changed",
  /** BookmarkPanel → FileList: 指定パスの親フォルダを開いて、その項目を選択する
   *  （ラベル一覧からファイルを開くときの「場所を表示」相当）。 */
  REVEAL_PATH: "kf-reveal-path",
  /** FileList → LayoutRoot: プロジェクトタスクを持つマニフェスト（package.json /
   *  Cargo.toml / Makefile）にフォーカスが当たった。detail: { path: string } */
  MANIFEST_FOCUSED: "kf-manifest-focused",
  /** React の外（クラウド同期など）でファイルを削除したことの通知。
   *  LayoutRoot が受けて、タグ・カラーラベルの紐づけを捨てる。
   *  detail: { paths: string[] } */
  PATHS_DELETED: "kf-paths-deleted",
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];
