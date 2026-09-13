import { test as base, expect } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

/**
 * 全テストでページ読み込み前に Tauri モックを注入する `test`。
 * 各 spec はここから `test` / `expect` を import する。
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(installTauriMock);
    await use(page);
  },
});

export { expect };
