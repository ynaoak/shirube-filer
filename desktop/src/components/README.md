# components/ の構成規約

コンポーネントは役割別のサブディレクトリに配置する（直下にコンポーネントを置かない）。

| ディレクトリ | 役割 | 例 |
|---|---|---|
| `layout/` | アプリの骨格（ウィンドウ枠・ペイン・タブ・バー類） | LayoutRoot, PaneContainer, TabBar, StatusBar |
| `panels/` | サイドパネル・機能パネル（ActivityBar から開くもの） | FileTreePanel, GrepPanel, GitPanel, PreviewPanel |
| `dialogs/` | モーダル・ダイアログ・パレット | SettingsModal, ConflictDialog, CommandPalette |
| `viewers/` | ビューア・大型の専用ビュー | ImageViewer, DiffViewer, Terminal, FolderCompare |
| `providers/` | React コンテキスト・横断機構 | ThemeProvider, KeybindingProvider, ErrorBoundary |
| `common/` | 汎用の小物 UI | Icon, ContextMenu, ToastHost, EmptyState |
| `fileList/` | ファイル一覧（機能単位。本体 FileList.tsx + 部品・フック） | FileList, FileRow, useDirEntries |
| `cloudSync/` | クラウド同期（機能単位。本体 CloudSyncPanel.tsx + 部品） | CloudSyncPanel, CloudBrowserWindow |

方針:

- **機能のまとまりが大きいものは機能別ディレクトリ**（`fileList/` / `cloudSync/` のように本体 + 部品 + フックを同居させる）。
- それ以外は上記の役割別に置く。迷ったら「どこから開かれるか」で判断する
  （パネル → `panels/`、モーダル → `dialogs/`、常駐の枠 → `layout/`）。
- 新しい機能で部品が 3 つ以上になりそうなら、最初から機能別ディレクトリを切る。
