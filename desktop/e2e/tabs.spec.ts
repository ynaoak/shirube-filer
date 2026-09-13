import { test, expect } from "./support/fixtures";

/**
 * タブ操作の基本フロー。タブ要素は `data-tab-id` 属性を持つため、
 * これを数えることで i18n のラベルに依存せず開閉を検証できる。
 */
test.describe("tabs", () => {
  test("starts with a single Home tab", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    // 既定レイアウトは 1 ペイン・1 タブ
    await expect(page.locator("[data-tab-id]")).toHaveCount(1);
  });

  test("adds a new tab via the add-tab button", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.locator("[data-tab-id]")).toHaveCount(1);

    // 「+」ボタンの title は i18n テキスト（ja: タブを追加 / en: Add Tab）
    await page.getByRole("button", { name: /タブを追加|Add Tab/i }).click();
    await expect(page.locator("[data-tab-id]")).toHaveCount(2);
  });

  test("adds a tab with Ctrl+T and closes it with Ctrl+W", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    // ショートカットは layout-root の onKeyDown で処理されるためフォーカスを当てる
    const root = page.getByTestId("layout-root");
    await root.focus();

    await page.keyboard.press("Control+t");
    await expect(page.locator("[data-tab-id]")).toHaveCount(2);

    await root.focus();
    await page.keyboard.press("Control+w");
    await expect(page.locator("[data-tab-id]")).toHaveCount(1);
  });
});
