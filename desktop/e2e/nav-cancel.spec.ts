import { test, expect } from "./support/fixtures";

/**
 * 読み込みが遅いフォルダへ移動したときの中断。
 *
 * ネットワークボリュームやスリープ中の外付けディスクでは read_dir が数十秒
 * 返らないことがある。その間も
 *   - 「キャンセル」で直前の一覧に戻れること
 *   - 別パスへ移動し直せること
 *   - 遅れて返ってきた古い読み込みが、移動先の一覧を上書きしないこと
 * を検証する。
 */
const HOME = "/home/user";
const SLOW = "/home/user/slow";
const OTHER = "/home/user/other";

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
    "/home/user": [
      mk("/home/user", "slow", true),
      mk("/home/user", "other", true),
      mk("/home/user", "home-marker.txt", false),
    ],
    "/home/user/slow": [mk("/home/user/slow", "slow-marker.txt", false)],
    "/home/user/other": [mk("/home/user/other", "other-marker.txt", false)],
  };

  const w = window as unknown as Record<string, unknown>;
  // 遅いフォルダの read_dir を保留し、テストから任意のタイミングで解決させる。
  let releaseSlow: (() => void) | null = null;
  w.__releaseSlow = () => {
    releaseSlow?.();
    releaseSlow = null;
  };

  const install = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || (internals as { __p?: boolean }).__p) return false;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as { path?: string };
      if (cmd === "read_dir") {
        const path = a.path ?? "";
        const result = { path, entries: tree[path] ?? [] };
        if (path === "/home/user/slow") {
          return new Promise((resolve) => {
            releaseSlow = () => resolve(result);
          });
        }
        return Promise.resolve(result);
      }
      if (cmd === "get_parent_dir") {
        const p = (a.path ?? "").replace(/\/+$/, "");
        const idx = p.lastIndexOf("/");
        return Promise.resolve(idx > 0 ? p.slice(0, idx) : idx === 0 ? "/" : null);
      }
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

async function goTo(page: Page, dir: string) {
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(dir);
  await pathInput.press("Enter");
}

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  await goTo(page, HOME);
  await expect(rows(page).filter({ hasText: "home-marker.txt" }).first()).toBeVisible();
}

const releaseSlow = (page: Page) =>
  page.evaluate(() => (window as unknown as { __releaseSlow: () => void }).__releaseSlow());

test.describe("slow directory navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMock);
  });

  test("the cancel button returns to the previous listing", async ({ page }) => {
    await openHome(page);
    await goTo(page, SLOW);

    const cancel = page.getByRole("button", { name: /^(キャンセル|Cancel)$/ });
    await expect(cancel).toBeVisible();
    await cancel.click();

    // 直前の一覧に戻り、スケルトンは消えている
    await expect(cancel).toHaveCount(0);
    await expect(rows(page).filter({ hasText: "home-marker.txt" }).first()).toBeVisible();

    // 遅れて返ってきた読み込みが一覧を書き換えないこと
    await releaseSlow(page);
    await expect(rows(page).filter({ hasText: "slow-marker.txt" })).toHaveCount(0);
    await expect(rows(page).filter({ hasText: "home-marker.txt" }).first()).toBeVisible();
  });

  test("Escape cancels the pending load", async ({ page }) => {
    await openHome(page);
    await goTo(page, SLOW);

    const cancel = page.getByRole("button", { name: /^(キャンセル|Cancel)$/ });
    await expect(cancel).toBeVisible();

    // 読み込み中は一覧がスケルトンなので、ペイン自体にフォーカスして Esc を送る
    // （入力欄にフォーカスが残っているとリスト側のハンドラへ届かない）
    await page.getByTestId("file-list").first().focus();
    await page.keyboard.press("Escape");
    await expect(cancel).toHaveCount(0);
    await expect(rows(page).filter({ hasText: "home-marker.txt" }).first()).toBeVisible();
  });

  test("moving to another path while loading wins over the slow one", async ({ page }) => {
    await openHome(page);
    await goTo(page, SLOW);
    await expect(page.getByRole("button", { name: /^(キャンセル|Cancel)$/ })).toBeVisible();

    // 読み込み中でも別パスへ移動できる
    await goTo(page, OTHER);
    await expect(rows(page).filter({ hasText: "other-marker.txt" }).first()).toBeVisible();

    // 遅い read_dir が後から返っても、移動先の一覧のままであること
    await releaseSlow(page);
    await expect(rows(page).filter({ hasText: "slow-marker.txt" })).toHaveCount(0);
    await expect(rows(page).filter({ hasText: "other-marker.txt" }).first()).toBeVisible();
  });
});
