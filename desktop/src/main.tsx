// 他の import より前に: ブランド統一（kakashi→shirube）の localStorage 移行を実行する。
// i18n / stores / ThemeProvider がキーを読む前に新キーへ移行しておく必要がある。
import "./lib/brandMigration.boot";
import React from "react";
import ReactDOM from "react-dom/client";
// Monaco の Worker 設定は重い monaco 本体と一緒に CodeEditor 内で遅延ロードする
// （起動時には読み込まない）。
import "./i18n"; // initialize i18n before any component renders
import "material-symbols";
// Noto Sans（可変フォント）を同梱。OS 未インストールでも常に Noto Sans で
// 表示するため self-host する（ラテン=Noto Sans / 日本語=Noto Sans JP、
// いずれも unicode-range で必要サブセットのみ読込）。
// 注: サブパス（.../wght.css）は fontsource の exports がワイルドカード
// （"./*.css"）でしか公開しておらず、環境によって解決に失敗する。パッケージ
// ルート（既定 export = index.css、内容は wght.css と同一）を import して
// どの環境でも確実に解決させる。
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-sans-jp";
import "./App.css";
import App from "./App";
import ThemeProvider from "./components/providers/ThemeProvider";
// モード別ウィンドウ（設定/キュー/比較/クラウドブラウザ）は該当モードでしか
// 使わないため遅延ロードにし、メインウィンドウの初期チャンクから除外する。
const SettingsModal = React.lazy(() => import("./components/dialogs/SettingsModal"));
const QueueWindowApp = React.lazy(() => import("./components/layout/QueueWindowApp"));
const FolderCompare = React.lazy(() => import("./components/viewers/FolderCompare"));
const CloudBrowserWindow = React.lazy(() => import("./components/cloudSync/CloudBrowserWindow"));
const SyncLogWindow = React.lazy(() => import("./components/cloudSync/SyncLogWindow"));
// QuickPreviewModal は FileList から静的にインポートされ既にメインチャンクに
// 含まれるため、md-viewer ウィンドウ用途では遅延ロードにしても別チャンク化
// されない（Vite が警告する）。静的インポートに統一して警告を解消する。
import QuickPreviewModal from "./components/dialogs/QuickPreviewModal";
import AddonProvider from "./components/providers/AddonProvider";
import KeybindingProvider from "./components/providers/KeybindingProvider";
import { ThemeId, THEME_MAP } from "./store/themeStore";
import { applyTheme } from "./components/providers/ThemeProvider";
import { loadSettingsFromFile } from "./store/uiSettingsStore";
import { SyncProvider_ } from "./store/syncStore";

// Apply theme before React renders to prevent flash
const savedId = (localStorage.getItem("shirube-theme") as ThemeId) ?? "shirube-dark";
if (THEME_MAP[savedId] || savedId === "system" || savedId.startsWith("user-")) {
  applyTheme(savedId);
} else {
  applyTheme("shirube-dark");
}

// 設定ファイルを非同期で読み込み（UIレンダリングをブロックしない）
loadSettingsFromFile();

const searchParams = new URLSearchParams(window.location.search);
const mode = searchParams.get("mode");
const isSettingsWindow = mode === "settings";
const isQueueWindow = mode === "queue";
const isFolderCompareWindow = mode === "folder-compare";
const isCloudBrowserWindow = mode === "cloud-browser";
const isSyncLogWindow = mode === "sync-log";
const isMdViewerWindow = mode === "md-viewer";
const VALID_TABS = ["general", "display", "theme", "preview", "keybindings", "addon", "data", "layout"] as const;
const rawTab = searchParams.get("tab");
const initialTab = (VALID_TABS.includes(rawTab as typeof VALID_TABS[number]) ? rawTab : "general") as Parameters<typeof SettingsModal>[0]["initialTab"];

if (isCloudBrowserWindow) {
  const jobId = searchParams.get("job") ?? "";
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
      <ThemeProvider>
        <SyncProvider_>
          <CloudBrowserWindow jobId={jobId} />
        </SyncProvider_>
      </ThemeProvider>
    </React.Suspense>
    </React.StrictMode>,
  );
} else if (isSyncLogWindow) {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
      <ThemeProvider>
        <SyncLogWindow />
      </ThemeProvider>
      </React.Suspense>
    </React.StrictMode>,
  );
} else if (isMdViewerWindow) {
  const viewerPath = searchParams.get("path") ?? "";
  const closeWindow = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().close();
  };
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
      <ThemeProvider>
        <QuickPreviewModal standalone path={viewerPath} siblings={[viewerPath]} onClose={closeWindow} />
      </ThemeProvider>
      </React.Suspense>
    </React.StrictMode>,
  );
} else if (isFolderCompareWindow) {
  const leftPath = searchParams.get("left") ?? "";
  const rightPath = searchParams.get("right") ?? "";
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
      <ThemeProvider>
        <FolderCompare leftPath={leftPath} rightPath={rightPath} standalone />
      </ThemeProvider>
    </React.Suspense>
    </React.StrictMode>,
  );
} else if (isQueueWindow) {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
      <ThemeProvider>
        <QueueWindowApp />
      </ThemeProvider>
    </React.Suspense>
    </React.StrictMode>,
  );
} else if (isSettingsWindow) {
  // 設定ウィンドウとして起動
  const closeWindow = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().close();
  };

  // React マウント前（白画面フェーズ）に Escape が押された場合はフラグを立てる。
  // SettingsModal のマウント後にフラグを確認して閉じる（遅延処理）。
  const earlyEscapeHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      (window as unknown as Record<string, unknown>).__kf_pending_escape = true;
      document.removeEventListener("keydown", earlyEscapeHandler);
    }
  };
  document.addEventListener("keydown", earlyEscapeHandler);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
      <ThemeProvider>
        <AddonProvider>
          <KeybindingProvider>
            <SettingsModal standalone initialTab={initialTab} onClose={closeWindow} />
          </KeybindingProvider>
        </AddonProvider>
      </ThemeProvider>
    </React.Suspense>
    </React.StrictMode>,
  );
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
      <App />
    </React.Suspense>
    </React.StrictMode>,
  );
}
