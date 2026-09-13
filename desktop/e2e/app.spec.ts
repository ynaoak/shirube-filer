import { test, expect } from "./support/fixtures";

test.describe("app shell", () => {
  test("boots and renders the main shell", async ({ page }) => {
    await page.goto("/");

    // React がマウントして #root に内容が入る（致命的クラッシュなら空のまま）
    await expect(page.locator("#root")).not.toBeEmpty();
    // App のルートコンテナ（タイトルバー + 本体）が表示される
    await expect(page.locator("div.h-screen.w-screen")).toBeVisible();
  });
});

test.describe("command palette", () => {
  test("opens with Ctrl+Shift+P and closes with Escape", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    // ショートカットは LayoutRoot の div の onKeyDown で処理されるため、
    // まずその要素にフォーカスを当てる（起動直後は body にフォーカスがある）。
    await page.getByTestId("layout-root").focus();
    await page.keyboard.press("Control+Shift+P");

    const palette = page.getByRole("dialog", { name: /コマンドパレット|command/i });
    await expect(palette).toBeVisible();
    // 検索入力にフォーカスが当たる
    await expect(palette.locator("input")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("filters commands and shows no results for an unknown query", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    await page.getByTestId("layout-root").focus();
    await page.keyboard.press("Control+Shift+P");

    const palette = page.getByRole("dialog", { name: /コマンドパレット|command/i });
    await expect(palette).toBeVisible();

    // 初期状態ではコマンド行（cursor-pointer の行）が並ぶ
    const rows = palette.locator("div.cursor-pointer");
    expect(await rows.count()).toBeGreaterThan(0);

    // 一致しない文字列を入力すると候補が 0 件になる
    await palette.locator("input").fill("zzzznomatchqqqq");
    await expect(rows).toHaveCount(0);
  });
});
