// ── デモモードのサンプルデータ ────────────────────────────────────────
// LP スクリーンショット用に表示される仮想ファイルシステム・クラウド接続・
// 同期履歴。見栄えを調整したいときはこのファイルだけを編集すればよい
// （vite dev が即時リロードする）。
import type { FileEntry } from "../types/fs";

// 基準時刻: 2026-07-14 09:00 JST 付近。行ごとに少しずつずらして「最終更新」列に
// 自然なばらつきを出す。
const T = 1784332800; // 2026-07-14 00:00:00 UTC (epoch 秒)
const days = (n: number) => n * 86400;

// ── 仮想ファイルツリー ───────────────────────────────────────────────
// path → エントリ一覧。read_dir はこの Map を引くだけ。
type Spec = {
  name: string;
  dir?: boolean;
  size?: number;
  ago?: number; // 何日前に更新されたか
  hidden?: boolean;
  children?: Spec[];
};

const TREE: Spec = {
  name: "",
  dir: true,
  children: [
    {
      name: "home",
      dir: true,
      ago: 30,
      children: [
        {
          name: "user",
          dir: true,
          ago: 0,
          children: [
            {
              name: "Projects",
              dir: true,
              ago: 0,
              children: [
                {
                  name: "shirube-filer",
                  dir: true,
                  ago: 0,
                  children: [
                    { name: "src", dir: true, ago: 0, children: [
                      { name: "main.tsx", size: 4820, ago: 0 },
                      { name: "App.tsx", size: 12180, ago: 1 },
                      { name: "components", dir: true, ago: 0, children: [] },
                    ] },
                    { name: "src-tauri", dir: true, ago: 1, children: [] },
                    { name: "README.md", size: 5230, ago: 3 },
                    { name: "package.json", size: 1890, ago: 1 },
                    { name: "Cargo.toml", size: 940, ago: 5 },
                    { name: ".gitignore", size: 210, ago: 40, hidden: true },
                  ],
                },
                {
                  name: "website",
                  dir: true,
                  ago: 2,
                  children: [
                    { name: "index.astro", size: 10240, ago: 2 },
                    { name: "og-image.png", size: 68210, ago: 2 },
                  ],
                },
                { name: "design-mock.fig", size: 18874368, ago: 9 },
              ],
            },
            {
              name: "Documents",
              dir: true,
              ago: 1,
              children: [
                { name: "提案書_2026Q3.docx", size: 482344, ago: 1 },
                { name: "見積もり_v3.xlsx", size: 96411, ago: 2 },
                { name: "議事録 2026-07-10.md", size: 6120, ago: 4 },
                { name: "report-2026.pdf", size: 2411520, ago: 6 },
                { name: "契約書ドラフト.pdf", size: 1180430, ago: 12 },
              ],
            },
            {
              name: "Pictures",
              dir: true,
              ago: 0,
              children: [
                { name: "IMG_0231.jpg", size: 3480211, ago: 0 },
                { name: "IMG_0232.jpg", size: 4123908, ago: 0 },
                { name: "スクリーンショット 2026-07-12.png", size: 812430, ago: 2 },
                { name: "logo-draft.svg", size: 18211, ago: 14 },
              ],
            },
            {
              name: "Music",
              dir: true,
              ago: 20,
              children: [
                { name: "field-recording-01.wav", size: 48211002, ago: 20 },
                { name: "デモ音源.mp3", size: 8211002, ago: 25 },
              ],
            },
            {
              name: "Videos",
              dir: true,
              ago: 8,
              children: [
                { name: "screen-capture-demo.mp4", size: 152110022, ago: 8 },
              ],
            },
            {
              name: "Downloads",
              dir: true,
              ago: 0,
              children: [
                { name: "dataset-2026.zip", size: 68110022, ago: 0 },
                { name: "installer_x64.msi", size: 24110022, ago: 3 },
                { name: "sample-fonts.tar.zst", size: 9811002, ago: 7 },
              ],
            },
            { name: "TODO.md", size: 1420, ago: 0 },
            { name: "notes.txt", size: 812, ago: 1 },
            { name: ".config", dir: true, ago: 15, hidden: true, children: [] },
          ],
        },
      ],
    },
  ],
};

function extOf(name: string): string | null {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : null;
}

/** TREE を「path → FileEntry[]」の Map に展開する。 */
export function buildFs(): Map<string, FileEntry[]> {
  const map = new Map<string, FileEntry[]>();
  const walk = (spec: Spec, parentPath: string) => {
    const path = parentPath === "/" ? `/${spec.name}` : `${parentPath}/${spec.name}`;
    const self = spec.name === "" ? "/" : path;
    if (spec.dir) {
      const entries: FileEntry[] = (spec.children ?? []).map((c) => {
        const childPath = self === "/" ? `/${c.name}` : `${self}/${c.name}`;
        return {
          name: c.name,
          path: childPath,
          isDir: !!c.dir,
          isSymlink: false,
          isHidden: !!c.hidden,
          size: c.dir ? 0 : c.size ?? 0,
          modified: T - days(c.ago ?? 0),
          extension: c.dir ? null : extOf(c.name),
        };
      });
      map.set(self, entries);
      for (const c of spec.children ?? []) if (c.dir) walk(c, self);
    }
  };
  walk(TREE, "/");
  return map;
}

export const HOME_DIR = "/home/user";

export const VOLUMES = [
  { path: "/", label: "System", kind: "fixed" },
  { path: "/mnt/backup", label: "Backup", kind: "removable" },
];

// ── クラウド接続（クラウド同期パネル用） ─────────────────────────────
export const SYNC_JOBS = [
  {
    id: "demo-box",
    name: "Box 共有フォルダ",
    enabled: true,
    provider: "box",
    localPath: "/home/user/Documents",
    group: "仕事",
    box: { refreshToken: "", rootFolderId: "0" },
    autoDownloadInterval: 0,
    recursive: true,
    syncMode: "bidirectional",
    deletePropagation: false,
    lastSyncedPaths: [],
    lastSyncedAt: T - 3600,
  },
  {
    id: "demo-gdrive",
    name: "Google Drive バックアップ",
    enabled: true,
    provider: "gdrive",
    localPath: "/home/user/Pictures",
    group: "仕事",
    gdrive: { refreshToken: "", rootFolderId: "root" },
    autoDownloadInterval: 0,
    recursive: true,
    syncMode: "upload",
    deletePropagation: false,
    lastSyncedPaths: [],
    lastSyncedAt: T - 7200,
  },
  {
    id: "demo-s3",
    name: "S3 アーカイブ",
    enabled: false,
    provider: "s3",
    localPath: "/home/user/Downloads",
    s3: { accessKey: "", secretKey: "", region: "ap-northeast-1", endpoint: "", bucket: "my-archive", prefix: "2026/" },
    autoDownloadInterval: 0,
    recursive: false,
    syncMode: "download",
    deletePropagation: false,
    lastSyncedPaths: [],
    lastSyncedAt: T - days(2),
  },
];

// ── テキストプレビュー用のサンプル本文 ───────────────────────────────
export const TEXT_CONTENTS: Record<string, string> = {
  "/home/user/TODO.md": `# TODO

## 今週
- [x] 提案書のドラフトを共有
- [ ] スクリーンショットの差し替え
- [ ] リリースノートの下書き

## あとで
- [ ] アイコンの高解像度版を用意
- [ ] FAQ の英語版レビュー
`,
  "/home/user/notes.txt": `打ち合わせメモ (7/14)

- リリース目標: 今四半期末
- ストア申請は 2 週間前までに
- LP のスクリーンショットはデモモードで撮影する
`,
  "/home/user/Documents/議事録 2026-07-10.md": `# 定例 2026-07-10

参加: 開発チーム

## 決定事項
- クラウド同期の履歴保持は既定 10,000 件
- 競合時の既定動作は「自動リネーム」

## 持ち帰り
- ストア掲載文の最終確認
`,
};

// ── Git（Git パネル用: /home/user/Projects/shirube-filer をリポジトリに見せる） ──
export const GIT_STATUS = {
  root: "/home/user/Projects/shirube-filer",
  head: "main",
  files: [
    { path: "src/App.tsx", status: "staged-modified" },
    { path: "src/components/NewPanel.tsx", status: "staged-new" },
    { path: "src/main.tsx", status: "modified" },
    { path: "README.md", status: "modified" },
    { path: "notes/draft.md", status: "untracked" },
  ],
  branches: [
    { name: "main", isCurrent: true, isRemote: false },
    { name: "feature/preview-pane", isCurrent: false, isRemote: false },
    { name: "origin/main", isCurrent: false, isRemote: true },
  ],
};

export const GIT_LOG = [
  { oid: "a1b2c3d", message: "feat: プレビューペインを追加", author: "dev", time: T - 3600 },
  { oid: "b2c3d4e", message: "fix: タブ切替時のフォーカス喪失を修正", author: "dev", time: T - days(1) },
  { oid: "c3d4e5f", message: "chore: 依存を更新", author: "dev", time: T - days(2) },
  { oid: "d4e5f6a", message: "feat: キーバインド設定を実装", author: "dev", time: T - days(3) },
];

export const GIT_STASHES = [{ index: 0, message: "WIP: 実験的なレイアウト変更" }];

export const GIT_DIFF = `diff --git a/src/main.tsx b/src/main.tsx
index 1234567..89abcde 100644
--- a/src/main.tsx
+++ b/src/main.tsx
@@ -10,6 +10,8 @@ import App from "./App";
 import ThemeProvider from "./components/ThemeProvider";
+// モード別ウィンドウは遅延ロードにして初期チャンクから除外する
+const SettingsModal = React.lazy(() => import("./components/SettingsModal"));
 import AddonProvider from "./components/AddonProvider";
`;

// ── 同期履歴（履歴ビュー・ログウィンドウ用） ─────────────────────────
export const SYNC_HISTORY = [
  { ts: T - 600, jobId: "demo-box", jobName: "Box 共有フォルダ", provider: "box", direction: "download", name: "提案書_2026Q3.docx", status: "ok" },
  { ts: T - 610, jobId: "demo-box", jobName: "Box 共有フォルダ", provider: "box", direction: "upload", name: "議事録 2026-07-10.md", status: "ok" },
  { ts: T - 3600, jobId: "demo-gdrive", jobName: "Google Drive バックアップ", provider: "gdrive", direction: "upload", name: "IMG_0231.jpg", status: "ok" },
  { ts: T - 3620, jobId: "demo-gdrive", jobName: "Google Drive バックアップ", provider: "gdrive", direction: "upload", name: "IMG_0232.jpg", status: "ok" },
  { ts: T - days(1), jobId: "demo-s3", jobName: "S3 アーカイブ", provider: "s3", direction: "download", name: "dataset-2026.zip", status: "ok" },
  { ts: T - days(2), jobId: "demo-box", jobName: "Box 共有フォルダ", provider: "box", direction: "connect", name: "Box 共有フォルダ", status: "ok" },
];

// ── プロジェクトタスク（タスクパネル用） ──────────────────────────────
// Rust 側 task_commands.rs が返す形（ProjectTasks）をそのまま用意する。
// パスがこの dir 配下なら「上位フォルダ」扱いで同じ一覧を返す。
export const PROJECT_TASKS = [
  {
    dir: "/home/user/Projects/shirube-filer",
    manifests: [
      {
        kind: "node",
        file: "/home/user/Projects/shirube-filer/package.json",
        tool: "pnpm",
        name: "shirube-filer",
        tasks: [
          { id: "script:dev", label: "dev", detail: "vite", command: "pnpm run dev", kind: "run", longRunning: true },
          { id: "script:build", label: "build", detail: "tsc && vite build", command: "pnpm run build", kind: "build", longRunning: false },
          { id: "script:test", label: "test", detail: "vitest run", command: "pnpm run test", kind: "test", longRunning: false },
          { id: "script:test:e2e", label: "test:e2e", detail: "playwright test", command: "pnpm run test:e2e", kind: "test", longRunning: false },
          { id: "install", label: "pnpm install", detail: null, command: "pnpm install", kind: "install", longRunning: false },
        ],
      },
      {
        kind: "rust",
        file: "/home/user/Projects/shirube-filer/Cargo.toml",
        tool: "cargo",
        name: "shirube-filer",
        tasks: [
          { id: "run", label: "run", detail: null, command: "cargo run", kind: "run", longRunning: true },
          { id: "build-release", label: "build --release", detail: null, command: "cargo build --release", kind: "build", longRunning: false },
          { id: "test", label: "test", detail: null, command: "cargo test", kind: "test", longRunning: false },
          { id: "clippy", label: "clippy", detail: null, command: "cargo clippy", kind: "lint", longRunning: false },
        ],
      },
      {
        kind: "docker",
        file: "/home/user/Projects/shirube-filer/Dockerfile",
        tool: "docker",
        name: "shirube-filer",
        tasks: [
          { id: "build", label: "build -t shirube-filer", detail: null, command: "docker build -t shirube-filer .", kind: "build", longRunning: false },
          { id: "run", label: "run shirube-filer", detail: null, command: "docker run --rm -it shirube-filer", kind: "run", longRunning: true },
        ],
      },
    ],
  },
  {
    dir: "/home/user/Projects/website",
    manifests: [
      {
        kind: "node",
        file: "/home/user/Projects/website/package.json",
        tool: "pnpm",
        name: "website",
        tasks: [
          { id: "script:dev", label: "dev", detail: "astro dev", command: "pnpm run dev", kind: "run", longRunning: true },
          { id: "script:build", label: "build", detail: "astro build", command: "pnpm run build", kind: "build", longRunning: false },
          { id: "install", label: "pnpm install", detail: null, command: "pnpm install", kind: "install", longRunning: false },
        ],
      },
    ],
  },
];

// ── 組み込みサーバー（登録と、動いている配信） ──────────────────────
export const SERVER_PRESETS = [
  { id: "srv-demo-website", label: "", root: "/home/user/Projects/website", port: 8080, liveReload: true },
];

export const STATIC_SERVERS = [
  { port: 8080, root: "/home/user/Projects/website", url: "http://127.0.0.1:8080/", liveReload: true },
];

// ── パネル内シェルに流す模擬出力（コマンド行 → 出力） ─────────────────
// 実際の PTY は無いので、書き込まれたコマンドに応じてそれらしい出力を返す。
export const SHELL_PROMPT = "\x1b[1;32muser@dev\x1b[0m:\x1b[1;34m~/Projects/shirube-filer\x1b[0m$ ";
export const SHELL_OUTPUTS: Record<string, string> = {
  "pnpm run dev": [
    "",
    "> shirube-filer@1.0.0 dev",
    "> vite",
    "",
    "  \x1b[32m\x1b[1mVITE\x1b[0m \x1b[32mv7.3.1\x1b[0m  ready in \x1b[1m412\x1b[0m ms",
    "",
    "  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36mhttp://localhost:1420/\x1b[0m",
    "  \x1b[32m➜\x1b[0m  \x1b[1mNetwork\x1b[0m: use --host to expose",
    "",
  ].join("\r\n"),
  "cargo test": [
    "",
    "   \x1b[1;32mCompiling\x1b[0m shirube-filer v1.0.0 (/home/user/Projects/shirube-filer)",
    "    \x1b[1;32mFinished\x1b[0m test profile [unoptimized + debuginfo] target(s) in 4.21s",
    "     \x1b[1;32mRunning\x1b[0m unittests src/main.rs",
    "",
    "test result: \x1b[32mok\x1b[0m. 128 passed; 0 failed; 0 ignored",
    "",
  ].join("\r\n"),
};
