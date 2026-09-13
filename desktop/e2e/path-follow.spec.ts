import { test, expect } from "./support/fixtures";

/**
 * 移動・リネームへのタグ / カラーラベルの追従。
 *
 * どちらも「絶対パス → 値」で保存しているため、パスが変わると設定が迷子になる。
 * リネーム・D&D 移動のあとも紐づけが保たれることを検証する。
 * フォルダを動かした場合は配下ごと付け替わる必要がある。
 */
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
    "/home/user/work": [
      mk("/home/user/work", "dest", true),
      mk("/home/user/work", "note.txt", false),
      mk("/home/user/work", "box", true),
    ],
    "/home/user/work/dest": [],
    "/home/user/work/box": [mk("/home/user/work/box", "inner.txt", false)],
  };
  const w = window as unknown as Record<string, unknown>;
  // ストアが保存した最新の内容をテストから覗く
  w.__tags = { "/home/user/work/note.txt": ["重要"], "/home/user/work/box/inner.txt": ["中身"] };
  w.__labels = { "/home/user/work/note.txt": "#ef4444", "/home/user/work/box": "#22c55e" };

  const install = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || (internals as { __p?: boolean }).__p) return false;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as {
        path?: string; src?: string; dest?: string; newName?: string; trash?: boolean;
        tags?: Record<string, string[]>; labels?: Record<string, string>;
      };
      if (cmd === "read_dir") {
        return Promise.resolve({ path: a.path ?? "", entries: tree[a.path ?? ""] ?? [] });
      }
      if (cmd === "load_tags") return Promise.resolve(w.__tags);
      if (cmd === "save_tags") { w.__tags = a.tags ?? {}; return Promise.resolve(null); }
      if (cmd === "load_color_labels") return Promise.resolve(w.__labels);
      if (cmd === "save_color_labels") { w.__labels = a.labels ?? {}; return Promise.resolve(null); }
      // rename / move は成功したことにして一覧の中身も動かす
      if (cmd === "rename_item") {
        const src = a.src ?? "";
        const dir = src.replace(/\/[^/]*$/, "");
        const list = tree[dir] ?? [];
        const item = list.find((e) => e.path === src);
        if (item) { item.name = a.newName ?? item.name; item.path = `${dir}/${item.name}`; }
        return Promise.resolve(null);
      }
      if (cmd === "move_item") {
        const src = a.src ?? "", dest = a.dest ?? "";
        const srcDir = src.replace(/\/[^/]*$/, "");
        const destDir = dest.replace(/\/[^/]*$/, "");
        const list = tree[srcDir] ?? [];
        const idx = list.findIndex((e) => e.path === src);
        if (idx >= 0) {
          const [item] = list.splice(idx, 1);
          item.path = dest;
          item.name = dest.split("/").pop() ?? item.name;
          (tree[destDir] ??= []).push(item);
        }
        return Promise.resolve(null);
      }
      if (cmd === "delete_item") {
        const target = a.path ?? "";
        const dir = target.replace(/\/[^/]*$/, "");
        const list = tree[dir] ?? [];
        const idx = list.findIndex((e) => e.path === target);
        if (idx >= 0) list.splice(idx, 1);
        return Promise.resolve(null);
      }
      if (cmd === "get_parent_dir") return Promise.resolve((a.path ?? "").replace(/\/[^/]*$/, "") || "/");
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
const tagsOf = (page: Page) => page.evaluate(() => (window as unknown as { __tags: Record<string, string[]> }).__tags);
const labelsOf = (page: Page) => page.evaluate(() => (window as unknown as { __labels: Record<string, string> }).__labels);

async function openDir(page: Page, dir = DIR) {
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(dir);
  await pathInput.press("Enter");
  await expect(rows(page).first()).toBeVisible();
}

test.describe("tags and labels follow the file", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMock);
  });

  test("keeps the tag and label after renaming a file", async ({ page }) => {
    await openDir(page);
    await rows(page).filter({ hasText: "note.txt" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^リネーム|^Rename/ }).click();

    const input = page.locator('input[value="note.txt"], input').filter({ hasNot: page.locator("x") }).last();
    await input.fill("renamed.txt");
    await input.press("Enter");

    await expect.poll(() => tagsOf(page)).toMatchObject({ "/home/user/work/renamed.txt": ["重要"] });
    await expect.poll(() => tagsOf(page).then((t) => t["/home/user/work/note.txt"])).toBeUndefined();
    await expect.poll(() => labelsOf(page)).toMatchObject({ "/home/user/work/renamed.txt": "#ef4444" });
  });

  test("keeps the tag and label after a drag move into a folder", async ({ page }) => {
    await openDir(page);
    const src = rows(page).filter({ hasText: "note.txt" }).first();
    const dst = rows(page).filter({ hasText: "dest" }).first();
    await src.dragTo(dst);

    await expect.poll(() => tagsOf(page)).toMatchObject({ "/home/user/work/dest/note.txt": ["重要"] });
    await expect.poll(() => labelsOf(page)).toMatchObject({ "/home/user/work/dest/note.txt": "#ef4444" });
    await expect.poll(() => tagsOf(page).then((t) => t["/home/user/work/note.txt"])).toBeUndefined();
  });

  test("moving a folder carries the metadata of everything inside it", async ({ page }) => {
    await openDir(page);
    const src = rows(page).filter({ hasText: "box" }).first();
    const dst = rows(page).filter({ hasText: "dest" }).first();
    await src.dragTo(dst);

    // フォルダ自身のラベルと、配下のファイルのタグが両方付いてくる
    await expect.poll(() => labelsOf(page)).toMatchObject({ "/home/user/work/dest/box": "#22c55e" });
    await expect.poll(() => tagsOf(page)).toMatchObject({ "/home/user/work/dest/box/inner.txt": ["中身"] });
    await expect.poll(() => tagsOf(page).then((t) => t["/home/user/work/box/inner.txt"])).toBeUndefined();
  });

  test("drops the tag and label when a file is deleted", async ({ page }) => {
    await openDir(page);
    page.on("dialog", (d) => d.accept());

    await rows(page).filter({ hasText: "note.txt" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /削除（ゴミ箱）|Delete \(Trash\)/ }).click();

    await expect.poll(() => tagsOf(page).then((t) => t["/home/user/work/note.txt"])).toBeUndefined();
    await expect.poll(() => labelsOf(page).then((l) => l["/home/user/work/note.txt"])).toBeUndefined();
    // 巻き込み削除が起きていないこと
    await expect.poll(() => tagsOf(page).then((t) => t["/home/user/work/box/inner.txt"])).toEqual(["中身"]);
  });

  test("drops the metadata of everything inside a deleted folder", async ({ page }) => {
    await openDir(page);
    page.on("dialog", (d) => d.accept());

    await rows(page).filter({ hasText: "box" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /削除（ゴミ箱）|Delete \(Trash\)/ }).click();

    await expect.poll(() => labelsOf(page).then((l) => l["/home/user/work/box"])).toBeUndefined();
    await expect.poll(() => tagsOf(page).then((t) => t["/home/user/work/box/inner.txt"])).toBeUndefined();
    // 無関係なものは残る
    await expect.poll(() => tagsOf(page).then((t) => t["/home/user/work/note.txt"])).toEqual(["重要"]);
  });
});
