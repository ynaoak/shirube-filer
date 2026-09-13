import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ThemeProvider from "./components/providers/ThemeProvider";
import LayoutRoot from "./components/layout/LayoutRoot";
import ErrorBoundary from "./components/providers/ErrorBoundary";
import { TagProvider } from "./store/tagStore";
import { ColorLabelProvider } from "./store/colorLabelStore";
import { RuleProvider } from "./store/ruleStore";
import { SyncProvider_ } from "./store/syncStore";
import { checkForUpdateSilently } from "./lib/updater";
import { showToast } from "./lib/toast";
import i18n from "./i18n";

/**
 * OS / ウィンドウフォーカス状態に応じた body クラスを管理する。
 * - kf-os-{windows|macos|linux}: OS 固有のスクロールバー等を切り替える
 * - kf-window-inactive: 非フォーカス時に title bar の文字を薄くする
 */
function useNativeBodyClasses() {
  useEffect(() => {
    let unlistenFocus: (() => void) | undefined;
    let unlistenBlur: (() => void) | undefined;

    invoke<string>("get_platform")
      .then((os) => {
        document.body.classList.add(`kf-os-${os}`);
      })
      .catch(() => {});

    const win = getCurrentWindow();
    win
      .isFocused()
      .then((focused) => {
        document.body.classList.toggle("kf-window-inactive", !focused);
      })
      .catch(() => {});

    win
      .onFocusChanged(({ payload: focused }) => {
        document.body.classList.toggle("kf-window-inactive", !focused);
      })
      .then((fn) => {
        unlistenFocus = fn;
      })
      .catch(() => {});

    return () => {
      unlistenFocus?.();
      unlistenBlur?.();
    };
  }, []);
}

/** 起動時にアップデートを静かに確認し、あればトーストで知らせる（メインウィンドウのみ）。 */
const STARTUP_UPDATE_CHECK_DELAY_MS = 5000;

function useStartupUpdateCheck() {
  useEffect(() => {
    // 切り離したタブのウィンドウ（main-*）ごとに通知しない
    if (getCurrentWindow().label !== "main") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      checkForUpdateSilently().then((version) => {
        if (!cancelled && version) showToast(i18n.t("settings.updateAvailableToast", { version }), "info");
      });
    }, STARTUP_UPDATE_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
}

export default function App() {
  useNativeBodyClasses();
  useStartupUpdateCheck();
  return (
    <ThemeProvider>
      <TagProvider>
        <ColorLabelProvider>
        <RuleProvider>
          <SyncProvider_>
            {/* 本体（decorations: false 前提）。タイトルバーはグループタブバー
                （LayoutRoot 内）に統合し、ウィンドウ操作もそこに置く。 */}
            <div className="flex flex-col h-screen w-screen overflow-hidden">
              {/* 最後の砦: 予期しないクラッシュでも真っ暗ではなくエラー表示にする */}
              <ErrorBoundary variant="fill">
                <LayoutRoot />
              </ErrorBoundary>
            </div>
          </SyncProvider_>
        </RuleProvider>
        </ColorLabelProvider>
      </TagProvider>
    </ThemeProvider>
  );
}
