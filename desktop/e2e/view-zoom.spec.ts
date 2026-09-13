import { test, expect } from "./support/fixtures";

/**
 * 表示形式の段階切替と、コンテキストメニューからのプレビュー。
 *
 * Ctrl + "+"/"-" と Ctrl + ホイールで、詳細 → 一覧 → サムネイル小 → 大 の
 * 順に一段ずつ動く（Explorer と同じ密度順）。両端では動かない。
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
      if (cmd === "read_text_file_preview") return Promise.resolve({ content: "hello", truncated: false });
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

const list = (page: Page) => page.locator('[data-testid="file-list"]').first();

/** 今どの表示形式かを、DOM の形から読み取る。 */
async function currentView(page: Page): Promise<"details" | "compact" | "grid-small" | "grid-large"> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="file-list"]')!;
    if (el.querySelector("[data-file-content]")) return "details" as const;
    const tile = el.querySelector("[data-grid-item]") as HTMLElement | null;
    if (!tile) throw new Error("タイルも詳細表示も見つからない");
    // サムネイル表示は縦積み、一覧表示は横並び。
    const thumb = tile.firstElementChild as HTMLElement;
    const side = thumb.getBoundingClientRect().width;
    if (side <= 24) return "compact" as const;
    return side > 96 ? ("grid-large" as const) : ("grid-small" as const);
  });
}

async function openDir(page: Page) {
  await page.addInitScript(installMock);
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(DIR);
  await pathInput.press("Enter");
  await expect(page.locator("[data-name-cell]")).toHaveCount(3);
  // 一覧にフォーカスを移す（ショートカットは一覧が持っている）。
  await list(page).click({ position: { x: 300, y: 400 } });
}

test.describe("view zoom", () => {
  test("Ctrl+plus steps up through the four view modes and stops at the top", async ({ page }) => {
    await openDir(page);
    expect(await currentView(page)).toBe("details");

    for (const expected of ["compact", "grid-small", "grid-large"] as const) {
      await page.keyboard.press("Control+=");
      await expect.poll(() => currentView(page)).toBe(expected);
    }

    // 端では回り込まない（詳細表示へ一気に飛ばない）。
    await page.keyboard.press("Control+=");
    await expect.poll(() => currentView(page)).toBe("grid-large");
  });

  test("Ctrl+minus steps back down and stops at details", async ({ page }) => {
    await openDir(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Control+=");
    await expect.poll(() => currentView(page)).toBe("grid-large");

    for (const expected of ["grid-small", "compact", "details"] as const) {
      await page.keyboard.press("Control+-");
      await expect.poll(() => currentView(page)).toBe(expected);
    }

    await page.keyboard.press("Control+-");
    await expect.poll(() => currentView(page)).toBe("details");
  });

  test("Ctrl+wheel changes the view but a plain wheel does not", async ({ page }) => {
    await openDir(page);
    await list(page).hover({ position: { x: 300, y: 400 } });

    await page.mouse.wheel(0, -120);
    await expect.poll(() => currentView(page)).toBe("details");

    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await expect.poll(() => currentView(page)).toBe("compact");

    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 120);
    await page.keyboard.up("Control");
    await expect.poll(() => currentView(page)).toBe("details");
  });

  // 選んだ表示形式は kf-view-mode-<タブ id> に保存され、タブ単位で残る。
  // 再読み込みをまたぐ確認はここでは行えない: レイアウト（＝タブ id）は
  // load_layout / save_layout で Tauri 側に保存されており、E2E のモックは
  // それを持たないためリロードのたびにタブ id が振り直される。
});

test.describe("show in preview", () => {
  test("offers preview for a file and opens it", async ({ page }) => {
    await openDir(page);
    await page.locator("[data-name-cell]").filter({ hasText: "alpha.txt" }).click({ button: "right" });

    const item = page.getByText("プレビューで表示する", { exact: true });
    await expect(item).toBeVisible();
    await item.click();

    // クイックプレビューが開く（タイトルはロケールに依らず data で判別できないため文言で見る）。
    await expect(page.getByText("alpha.txt").last()).toBeVisible();
  });

  test("does not offer preview for a folder", async ({ page }) => {
    await openDir(page);
    await page.locator("[data-name-cell]").filter({ hasText: "gamma" }).click({ button: "right" });

    await expect(page.getByText("削除（ゴミ箱）", { exact: true })).toBeVisible();
    await expect(page.getByText("プレビューで表示する", { exact: true })).toHaveCount(0);
  });
});
