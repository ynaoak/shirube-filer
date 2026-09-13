import { test, expect } from "./support/fixtures";

/**
 * グループタブの変更ポップアップ（名前 / 色）。
 *
 * リグレッション対象: macOS（WKWebView = WebKit）でグループ色をクリックしても
 * 変わらなかった問題。WebKit はボタンをクリックしてもフォーカスを移さないため、
 * 名前入力にフォーカスがある状態で色スウォッチを押すと
 *   mousedown → focusout(input) → focusin(ポップアップ外) → mouseup
 * となり、focusin を外側扱いして閉じるとボタンが click 前に消える。
 * そのため click ハンドラが一度も呼ばれず色が変わらなかった。
 * この spec は webkit プロジェクトで実行されたときにその退行を捕まえる。
 */
test.describe("group menu", () => {
  /** グループタブ先頭の色ドット（先頭 span）の実効背景色 */
  const dotColor = (page: import("@playwright/test").Page) =>
    page.locator("[data-group-id]").first().locator("span").first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);

  test("changes the group color from a preset swatch", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    const before = await dotColor(page);

    // ダブルクリックで開くと名前入力へ自動フォーカスが当たる（退行の再現条件）
    await page.locator("[data-group-id]").first().dblclick();
    const menu = page.locator(".kf-surface-menu");
    await expect(menu).toBeVisible();

    // 色スウォッチ = 子要素を持たない丸ボタン。現在色とは別のものを選ぶ。
    const swatches = menu.locator("button").filter({ hasNot: page.locator("*") });
    await swatches.nth(3).click();

    await expect.poll(() => dotColor(page)).not.toBe(before);
  });

  test("applies a custom color from the color input", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    await page.locator("[data-group-id]").first().dblclick();
    const menu = page.locator(".kf-surface-menu");
    await expect(menu).toBeVisible();

    await menu.locator('input[type="color"]').evaluate((el: HTMLInputElement) => {
      el.value = "#00ff88";
    });
    await menu.getByRole("button", { name: /適用|Apply/ }).click();

    await expect.poll(() => dotColor(page)).toBe("rgb(0, 255, 136)");
  });

  test("commits the renamed group on outside click", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    await page.locator("[data-group-id]").first().dblclick();
    const menu = page.locator(".kf-surface-menu");
    await expect(menu).toBeVisible();

    await menu.locator("input:not([type=color])").fill("しらべ");
    await page.mouse.click(900, 600);

    await expect(menu).toHaveCount(0);
    await expect(page.locator("[data-group-id]").first()).toContainText("しらべ");
  });

  test("closes without renaming on Escape", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    const tab = page.locator("[data-group-id]").first();
    // タブは「色ドット + 名前 + タブ数バッジ」なので、名前の部分だけを見る。
    await expect(tab).toContainText("Group 1");

    await tab.dblclick();
    const menu = page.locator(".kf-surface-menu");
    await expect(menu).toBeVisible();

    await menu.locator("input:not([type=color])").fill("捨てられる名前");
    await page.keyboard.press("Escape");

    await expect(menu).toHaveCount(0);
    await expect(tab).not.toContainText("捨てられる名前");
    await expect(tab).toContainText("Group 1");
  });
});
