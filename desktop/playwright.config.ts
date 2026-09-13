import { defineConfig, devices } from "@playwright/test";

// @types/node に依存せず CI 判定（process は実行時の Node グローバル）
const isCI = !!(globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.CI;

/**
 * Tauri アプリのフロントエンドをブラウザ（Chromium）で起動し、Tauri invoke を
 * モックして UI を検証する e2e 設定。
 * - webServer: vite 開発サーバー（pnpm dev, :1420）を自動起動
 * - Tauri モックは e2e/support/fixtures.ts が addInitScript で注入
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 1 : undefined,
  reporter: [
    ["list"],
    ["html", { outputFolder: "e2e/reports", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // macOS 版が実際に載るのは WKWebView（＝WebKit）なので、Chromium だけでは
    // macOS 固有の挙動差を取りこぼす。実例: WebKit はボタンをクリックしても
    // フォーカスを移さないため、focusin でポップアップを閉じる実装だと中の
    // ボタンが click 前に unmount されて効かなくなる（グループ色の変更）。
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
