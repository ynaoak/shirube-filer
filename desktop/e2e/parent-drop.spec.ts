import { test, expect } from "./support/fixtures";

/**
 * 一覧の一番上に置いた「上の階層へ」行。
 *
 * ペイン内の D&D だけで階層を上げられるようにするためのドロップ先。
 * 仮想スクロールの外に固定しているので、下までスクロールしても消えない。
 */
const ROOT = "/home";
const SUB = "/home/user/work";

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
    "/": [mk("", "home", true)],
    "/home": [mk("/home", "user", true)],
    "/home/user": [mk("/home/user", "work", true)],
    // スクロールが出るように多めに入れる
    "/home/user/work": [
      mk("/home/user/work", "a-moveme.txt", false),
      ...Array.from({ length: 40 }, (_, i) => mk("/home/user/work", `f${String(i).padStart(2, "0")}.txt`, false)),
    ],
  };
  const w = window as unknown as Record<string, unknown>;
  w.__moves = [];

  const install = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || (internals as { __p?: boolean }).__p) return false;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as { path?: string; src?: string; dest?: string };
      if (cmd === "read_dir") return Promise.resolve({ path: a.path ?? "", entries: tree[a.path ?? ""] ?? [] });
      if (cmd === "get_parent_dir") {
        const p = (a.path ?? "").replace(/\/+$/, "");
        const idx = p.lastIndexOf("/");
        return Promise.resolve(idx > 0 ? p.slice(0, idx) : idx === 0 ? "/" : null);
      }
      if (cmd === "move_item") {
        (w.__moves as unknown[]).push({ src: a.src, dest: a.dest });
        return Promise.resolve(null);
      }
      if (cmd === "path_exists") return Promise.resolve(false);
      if (cmd === "paths_exist") return Promise.resolve([]);
      if (cmd === "get_file_metadata") return Promise.resolve({ size: 100, isDir: false });
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
const parentRow = (page: Page) => page.locator("[data-parent-drop]");
const movesOf = (page: Page) => page.evaluate(() => (window as unknown as { __moves: unknown[] }).__moves);

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

test.describe("parent drop row", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMock);
  });

  test("dropping a file on it moves the file to the parent folder", async ({ page }) => {
    await openDir(page, SUB);
    await rows(page).filter({ hasText: "a-moveme.txt" }).first().dragTo(parentRow(page));

    await expect.poll(() => movesOf(page)).toEqual([
      { src: "/home/user/work/a-moveme.txt", dest: "/home/user/a-moveme.txt" },
    ]);
  });

  test("clicking it navigates up one level", async ({ page }) => {
    await openDir(page, SUB);
    await parentRow(page).click();
    // /home/user の中身（work だけ）になる
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveText("work");
  });

  test("stays visible after scrolling to the bottom of a long list", async ({ page }) => {
    await openDir(page, SUB);
    await expect(parentRow(page)).toBeInViewport();

    await page.locator("[role=listbox]").evaluate((el) => {
      const scroller = el.closest(".overflow-y-auto") as HTMLElement | null;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForTimeout(300);

    // 仮想スクロールの外に固定しているので、一番下までスクロールしても残る
    await expect(parentRow(page)).toBeInViewport();
  });

  test("is hidden at the filesystem root", async ({ page }) => {
    await openDir(page, ROOT);
    await expect(parentRow(page)).toHaveCount(1); // /home には親 "/" がある

    await openDir(page, "/");
    // ルートでは行を出さない（ツールバーの ↑ ボタンは従来どおり残る）
    await expect(parentRow(page)).toHaveCount(0);
  });

  test("highlights itself while a file is dragged over it", async ({ page }) => {
    await openDir(page, SUB);
    const row = parentRow(page);
    const before = await row.evaluate((el) => getComputedStyle(el).outlineWidth);

    const src = rows(page).filter({ hasText: "a-moveme.txt" }).first();
    const s = (await src.boundingBox())!;
    const d = (await row.boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 20, { steps: 4 });
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 10 });

    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe("2px");

    await page.mouse.up();
    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(before);
  });

  test("highlights on dragenter alone, without waiting for a dragover", async ({ page }) => {
    // 行が薄いので、カーソルが入った直後に止まると dragover が 1 度も来ない。
    // dragenter だけでハイライトが点くことを担保する。
    await openDir(page, SUB);
    const row = parentRow(page);

    await row.evaluate((el) => {
      const ev = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
      el.dispatchEvent(ev);
    });

    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe("2px");
  });
});
