import { test, expect } from "./support/fixtures";

/**
 * 右クリックメニューからのタグ付け。
 *
 * これまでタグはタグパネル（プレビュー中の 1 ファイルのみ対象）からしか
 * 付けられなかった。一覧の右クリック → 「タグ…」でダイアログを開き、
 * 選択したものすべてに付け外しできることを検証する。
 */
const DIR = "/home/user/work";

const installMock = () => {
  const mk = (name: string, isDir: boolean) => ({
    name,
    path: `/home/user/work/${name}`,
    isDir,
    isSymlink: false,
    isHidden: false,
    size: isDir ? 0 : 100,
    modified: 1_750_000_000,
    extension: isDir ? null : name.split(".").pop() ?? null,
  });
  // 保存されたタグは save_tags で受け取り、テストから覗けるようにする
  const saved: Record<string, string[]> = { "/home/user/work/b.txt": ["既存"] };
  (window as unknown as Record<string, unknown>).__tags = saved;

  const install = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || (internals as { __p?: boolean }).__p) return false;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as { path?: string; tags?: Record<string, string[]> };
      if (cmd === "read_dir") {
        return Promise.resolve({
          path: "/home/user/work",
          entries: [mk("a.txt", false), mk("b.txt", false), mk("c.txt", false)],
        });
      }
      if (cmd === "load_tags") return Promise.resolve(saved);
      if (cmd === "save_tags") {
        const w = window as unknown as Record<string, unknown>;
        w.__tags = a.tags ?? {};
        return Promise.resolve(null);
      }
      if (cmd === "get_file_metadata") return Promise.resolve({ size: 100, isDir: false });
      if (cmd === "path_exists") return Promise.resolve(false);
      if (cmd === "paths_exist") return Promise.resolve([]);
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
const savedTags = (page: Page) =>
  page.evaluate(() => (window as unknown as { __tags: Record<string, string[]> }).__tags);

async function openDir(page: Page) {
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(DIR);
  await pathInput.press("Enter");
  await expect(rows(page)).toHaveCount(3);
}

/** 行を右クリックして「タグ…」を選び、ダイアログを開く */
async function openTagDialog(page: Page) {
  await page.getByRole("menuitem", { name: /^タグ…|^Tags…/ }).click();
  await expect(page.getByRole("dialog", { name: /^タグ$|^Tags$/ })).toBeVisible();
}

test.describe("tagging from the context menu", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMock);
  });

  test("adds a new tag to a single file", async ({ page }) => {
    await openDir(page);
    await rows(page).filter({ hasText: "a.txt" }).click({ button: "right" });
    await openTagDialog(page);

    await page.getByPlaceholder(/新しいタグ|New tag/).fill("重要");
    await page.getByRole("button", { name: /^追加$|^Add$/ }).click();

    await expect.poll(() => savedTags(page)).toMatchObject({ "/home/user/work/a.txt": ["重要"] });
  });

  test("applies a tag to every selected file at once", async ({ page }) => {
    await openDir(page);
    // a.txt と c.txt を Ctrl/Cmd クリックで複数選択
    await rows(page).filter({ hasText: "a.txt" }).click();
    await rows(page).filter({ hasText: "c.txt" }).click({ modifiers: ["ControlOrMeta"] });
    await rows(page).filter({ hasText: "c.txt" }).click({ button: "right" });
    await openTagDialog(page);

    await page.getByPlaceholder(/新しいタグ|New tag/).fill("まとめ");
    await page.keyboard.press("Enter");

    await expect.poll(() => savedTags(page)).toMatchObject({
      "/home/user/work/a.txt": ["まとめ"],
      "/home/user/work/c.txt": ["まとめ"],
    });
  });

  test("toggles an existing tag off", async ({ page }) => {
    await openDir(page);
    await rows(page).filter({ hasText: "b.txt" }).click({ button: "right" });
    await openTagDialog(page);

    // b.txt には「既存」が付いている → チェック済みで出る
    const existing = page.getByRole("menuitemcheckbox", { name: "既存" });
    await expect(existing).toHaveAttribute("aria-checked", "true");

    await existing.click();
    await expect.poll(() => savedTags(page).then((tg) => tg["/home/user/work/b.txt"])).toBeUndefined();
  });

  test("shows a mixed state when only part of the selection has the tag", async ({ page }) => {
    await openDir(page);
    await rows(page).filter({ hasText: "a.txt" }).click();
    await rows(page).filter({ hasText: "b.txt" }).click({ modifiers: ["ControlOrMeta"] });
    await rows(page).filter({ hasText: "b.txt" }).click({ button: "right" });
    await openTagDialog(page);

    // b.txt だけが「既存」を持つ → 中間状態
    const existing = page.getByRole("menuitemcheckbox", { name: /既存/ });
    await expect(existing).toHaveAttribute("aria-checked", "mixed");

    // 押すと選択全体に付く
    await existing.click();
    await expect.poll(() => savedTags(page)).toMatchObject({
      "/home/user/work/a.txt": ["既存"],
      "/home/user/work/b.txt": ["既存"],
    });
  });
});
