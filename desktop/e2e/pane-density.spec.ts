import { test, expect } from "./support/fixtures";

/**
 * ペイン幅に応じた中身の最適化。
 *
 * ペインを分割すると 1 ペインが数百 px まで狭くなる。そのままだと
 *  - フィルタチップのラベルが途中で切れて読めない（「コ・」）
 *  - 任意列（サイズ・更新日）に押されて名前列がほぼ消える
 *  - 検索欄が「ファイ」まで縮む
 * という状態になっていた。ペイン幅を ResizeObserver で見て畳む。
 *
 * ここでは分割 UI を操作する代わりにビューポートを縮める。ペインの実幅が
 * 変わる点は同じで、同じ ResizeObserver の経路を通る。
 */
const DIR = "/home/user/work";

const installMock = () => {
  const mk = (name: string, isDir: boolean) => ({
    name,
    path: `/home/user/work/${name}`,
    isDir,
    isSymlink: false,
    isHidden: false,
    size: 12345,
    modified: 1_750_000_000,
    extension: isDir ? null : name.split(".").pop() ?? null,
  });
  const entries = [mk("alpha.txt", false), mk("beta.png", false), mk("gamma", true)];
  const install = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || (internals as { __p?: boolean }).__p) return false;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as { path?: string };
      if (cmd === "read_dir") return Promise.resolve({ path: a.path ?? "", entries });
      if (cmd === "get_parent_dir") return Promise.resolve("/home/user");
      if (cmd === "path_exists") return Promise.resolve(false);
      if (cmd === "paths_exist") return Promise.resolve([]);
      if (cmd === "get_file_metadata") return Promise.resolve({ size: 1, isDir: false });
      return orig(cmd, args);
    };
    (internals as { __p?: boolean }).__p = true;
    return true;
  };
  if (!install()) {
    const timer = setInterval(() => install() && clearInterval(timer), 5);
    setTimeout(() => clearInterval(timer), 5000);
  }
};

type Page = import("@playwright/test").Page;

const rows = (page: Page) => page.locator("[data-name-cell]");
const cols = (page: Page) => page.locator("[data-col]");
/** 種別フィルタのチップ（先頭 = すべて）。 */
const firstChip = (page: Page) => page.getByRole("button", { name: /^すべて$|^All$/ }).first();

async function openDir(page: Page) {
  await page.addInitScript(installMock);
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(DIR);
  await pathInput.press("Enter");
  await expect(rows(page)).toHaveCount(3);
}

/** 名前セルの実効幅（狭いときに潰れていないか） */
const nameCellWidth = (page: Page) =>
  rows(page).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));

test.describe("pane density", () => {
  test("wide pane keeps chip labels and every configured column", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDir(page);

    await expect(firstChip(page)).toHaveText(/すべて|All/);
    // 既定の任意列（サイズ・更新日）が出ている
    await expect(cols(page)).toHaveCount(2);
    await expect(page.locator('[data-col="size"]')).toHaveCount(1);
    await expect(page.locator('[data-col="modified"]')).toHaveCount(1);
  });

  test("narrow pane drops chip labels so they stop being truncated", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDir(page);
    await expect(firstChip(page)).toContainText(/すべて|All/);

    // ペイン幅 480px 未満でラベルを畳む（ビューポート 700 ≒ ペイン 434）
    await page.setViewportSize({ width: 700, height: 900 });
    // アイコン（Material Symbols のリガチャ文字）だけが残り、ラベル文字は消える。
    // ボタン自体とアクセシブル名（title / aria-label）は残す。
    await expect.poll(() => firstChip(page).innerText()).not.toMatch(/すべて|All/);
    await expect(firstChip(page)).toBeVisible();
  });

  test("narrow pane drops low-priority columns to keep the name readable", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDir(page);
    await expect(cols(page)).toHaveCount(2);
    const wideName = await nameCellWidth(page);

    // ビューポート 620 ≒ ペイン 354。更新日が先に落ちる（サイズより幅を食うため）。
    await page.setViewportSize({ width: 620, height: 900 });
    await expect.poll(() => page.locator('[data-col="modified"]').count()).toBe(0);
    await expect(page.locator('[data-col="size"]')).toHaveCount(1);

    // 名前セルが潰れていないこと（畳まないと minmax の下限まで縮む）
    expect(await nameCellWidth(page)).toBeGreaterThan(0);
    expect(await nameCellWidth(page)).toBeLessThanOrEqual(wideName);
  });

  test("widening the pane restores the columns and labels", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDir(page);
    await page.setViewportSize({ width: 620, height: 900 });
    await expect.poll(() => cols(page).count()).toBe(1);

    // ユーザーの列設定は書き換えていないので、広げれば元に戻る
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => cols(page).count()).toBe(2);
    await expect.poll(() => firstChip(page).innerText()).toMatch(/すべて|All/);
  });

  // ── 極端に狭いとき（ペイン < 320px。ビューポート 470 ≒ ペイン 280） ──────
  // ここでは UI を消しているので、消した機能に必ず別の入口があることを検証する。
  test.describe("minimal pane", () => {
    const goMinimal = async (page: Page) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openDir(page);
      await page.setViewportSize({ width: 470, height: 900 });
      await expect.poll(() => page.locator("[data-col]").count()).toBe(0);
    };

    test("folds the address bar, filter row, column header and stats footer", async ({ page }) => {
      await goMinimal(page);
      await expect(page.locator("[data-parent-drop]")).toHaveCount(1); // 「..」は残す
      await expect(page.locator("[data-col]")).toHaveCount(0);
      await expect(page.locator("input").first()).toHaveCount(1); // 検索欄は残す
      // パンくず（パスの各要素）が消えている
      await expect(page.getByRole("button", { name: "/home/user/work" })).toHaveCount(0);
    });

    test("Cmd+L still opens the path input while the address bar is folded", async ({ page }) => {
      await goMinimal(page);
      await expect(page.getByRole("button", { name: "/home/user/work" })).toHaveCount(0);

      await rows(page).first().click();
      await page.keyboard.press("ControlOrMeta+l");

      // アドレスバーが開き、パス入力にフォーカスが当たる
      const pathInput = page.locator("input").first();
      await expect(pathInput).toBeFocused();
      await expect(pathInput).toHaveValue("/home/user/work");
    });

    test("sorting is still reachable from the background context menu", async ({ page }) => {
      await goMinimal(page);
      // 一覧の空きスペース（仮想リストの下側）を右クリック
      await page.locator(".overflow-y-auto").last().click({ button: "right", position: { x: 20, y: 150 } });
      const menu = page.locator('[role="menu"]');
      await expect(menu).toBeVisible();
      await expect(menu.getByText(/^並び替え$|^Sort by$/)).toBeVisible();

      await menu.getByRole("menuitem", { name: /^サイズ$|^Size$/ }).click();
      // 名前昇順 → サイズ昇順 に変わる（先頭が入れ替わる）
      await expect.poll(() => rows(page).first().innerText()).not.toBe("alpha.txt");
    });

    test("the filter row can be opened from the search row", async ({ page }) => {
      await goMinimal(page);
      const chipRow = page.locator("button[data-label-color], button[title]").filter({ hasText: "" });
      await expect(firstChip(page)).toHaveCount(0);

      await page.locator("[data-filter-row-toggle]").click();
      await expect(firstChip(page)).toHaveCount(1);
      expect(await chipRow.count()).toBeGreaterThan(0);
    });

    test("keeps the filter row visible while a filter is active", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openDir(page);
      // 広いうちに絞り込んでおく
      await page.getByRole("button", { name: /^フォルダ$|^Folder$/ }).first().click();
      await expect(rows(page)).toHaveCount(1);

      await page.setViewportSize({ width: 470, height: 900 });
      // 絞り込み中は畳まない（隠れたまま空に見えるのを防ぐ）
      await expect(firstChip(page)).toHaveCount(1);
      await expect(page.locator("[data-filter-row-toggle]")).toHaveCount(0);
    });

    test("the tab tooltip carries the full path once the breadcrumb is gone", async ({ page }) => {
      await goMinimal(page);
      await expect(page.locator("[data-tab-id]").first()).toHaveAttribute("title", "/home/user/work");
    });
  });
});
