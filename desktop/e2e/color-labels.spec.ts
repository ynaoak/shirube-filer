import { test, expect } from "./support/fixtures";

/**
 * カラーラベル: ブックマークパネルへの表示と、色による絞り込み。
 *
 * - ファイル一覧のフィルタ行に、そのフォルダで使われている色だけチップを出す
 * - チップで一覧を絞り込む / もう一度押して解除する
 * - ブックマークの「ラベル」セクションにラベル付きの項目を並べ、色で絞り込む
 * - ラベル付き「ファイル」を選ぶと親フォルダを開いてその項目を選択する
 */
const RED = "#ef4444";
const GREEN = "#22c55e";
const DIR = "/home/user/work";

const installMock = () => {
  const mk = (dir: string, name: string, isDir: boolean) => ({
    name,
    path: `${dir}/${name}`,
    isDir,
    isSymlink: false,
    isHidden: false,
    size: isDir ? 0 : 100,
    modified: 1_750_000_000,
    extension: isDir ? null : name.split(".").pop() ?? null,
  });
  const tree: Record<string, Array<ReturnType<typeof mk>>> = {
    "/home/user/work": [mk("/home/user/work", "sub", true), mk("/home/user/work", "red.txt", false), mk("/home/user/work", "plain.txt", false)],
    "/home/user/work/sub": [mk("/home/user/work/sub", "deep.txt", false), mk("/home/user/work/sub", "other.txt", false)],
  };
  const labels: Record<string, string> = {
    "/home/user/work/red.txt": "#ef4444",
    "/home/user/work/sub": "#22c55e",
    "/home/user/work/sub/deep.txt": "#22c55e",
  };

  const install = () => {
    const internals = window.__TAURI_INTERNALS__ as
      | { invoke: (c: string, a?: unknown) => Promise<unknown>; __p?: boolean }
      | undefined;
    if (!internals || internals.__p) return false;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as { path?: string };
      if (cmd === "read_dir") {
        return Promise.resolve({ path: a.path ?? "", entries: tree[a.path ?? ""] ?? [] });
      }
      if (cmd === "load_color_labels") return Promise.resolve(labels);
      if (cmd === "save_color_labels") return Promise.resolve(null);
      if (cmd === "get_parent_dir") {
        return Promise.resolve((a.path ?? "").replace(/\/[^/]*$/, "") || "/");
      }
      if (cmd === "get_file_metadata") {
        const p = a.path ?? "";
        return Promise.resolve({ size: 100, isDir: !/\.[a-z]+$/i.test(p) });
      }
      if (cmd === "path_exists") return Promise.resolve(false);
      if (cmd === "paths_exist") return Promise.resolve([]);
      return orig(cmd, args);
    };
    internals.__p = true;
    return true;
  };
  if (!install()) {
    const timer = setInterval(() => install() && clearInterval(timer), 5);
    setTimeout(() => clearInterval(timer), 5000);
  }
};

type Page = import("@playwright/test").Page;

const rows = (page: Page) => page.locator("[data-name-cell]");
/** 色チップ。style の hex は rgb() へ正規化されるため data 属性で引く。 */
const listChip = (page: Page, color: string) =>
  page.locator(`button[data-label-color="${color}"]:not([data-label-scope])`);
const bookmarkChip = (page: Page, color: string) =>
  page.locator(`button[data-label-color="${color}"][data-label-scope="bookmark"]`);

async function openDir(page: Page, dir: string) {
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(dir);
  await pathInput.press("Enter");
  await expect(rows(page).first()).toBeVisible();
}

test.describe("color labels", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMock);
  });

  test("filter row shows only the colors used in the folder", async ({ page }) => {
    await openDir(page, DIR);
    // work/ で使われているのは赤（red.txt）と緑（sub）の 2 色だけ
    await expect(page.locator("button[data-label-color]")).toHaveCount(2);
    await expect(listChip(page, RED)).toHaveCount(1);
    await expect(listChip(page, GREEN)).toHaveCount(1);
  });

  test("clicking a color chip filters the list, clicking again clears it", async ({ page }) => {
    await openDir(page, DIR);
    await expect(rows(page)).toHaveCount(3);

    const redChip = listChip(page, RED);
    await redChip.click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveText("red.txt");
    await expect(redChip).toHaveAttribute("aria-pressed", "true");

    await redChip.click();
    await expect(rows(page)).toHaveCount(3);
    await expect(redChip).toHaveAttribute("aria-pressed", "false");
  });

  test("bookmark panel lists labeled items and filters them by color", async ({ page }) => {
    await openDir(page, DIR);
    await page.getByTitle(/ブックマーク|Bookmark/).first().click();

    await expect(page.getByText(/^ラベル$|^Labels$/).first()).toBeVisible();

    // 3 件すべて（red.txt / sub / sub/deep.txt）
    const labelRows = page.locator('[title="/home/user/work/red.txt"], [title="/home/user/work/sub"], [title="/home/user/work/sub/deep.txt"]');
    await expect(labelRows).toHaveCount(3);

    // 緑で絞ると sub と sub/deep.txt の 2 件
    const greenChip = bookmarkChip(page, GREEN);
    await greenChip.click();
    await expect(page.locator('[title="/home/user/work/red.txt"]')).toHaveCount(0);
    await expect(page.locator('[title="/home/user/work/sub"]')).toHaveCount(1);
    await expect(page.locator('[title="/home/user/work/sub/deep.txt"]')).toHaveCount(1);
  });

  test("opening a labeled file from bookmarks reveals it in its parent folder", async ({ page }) => {
    await openDir(page, DIR);
    await page.getByTitle(/ブックマーク|Bookmark/).first().click();

    // sub/deep.txt は今のフォルダ（work/）には無い。親（work/sub）を開いて選択されること。
    await page.locator('[title="/home/user/work/sub/deep.txt"]').click();

    await expect(rows(page).first()).toHaveText("deep.txt");
    await expect(rows(page)).toHaveCount(2);
    // 選択されている行が deep.txt であること
    await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
    await expect(page.locator('[role="option"][aria-selected="true"]')).toContainText("deep.txt");
  });
});
