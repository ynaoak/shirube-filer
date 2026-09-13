import { test, expect } from "./support/fixtures";

/**
 * 一覧内のドラッグ&ドロップでファイルをフォルダへ移動する。
 *
 * リグレッション対象:
 *  1. Tauri の `dragDropEnabled`（既定 true）が OS のドラッグハンドラを webview に
 *     登録し、常に「処理済み」を返すため wry が WebView 本来の drag 処理へ
 *     フォールバックせず、HTML5 の drag イベントがページに届かなくなっていた。
 *     → 設定は e2e では再現できないので、ここではページ側のロジック
 *       （dataTransfer のカスタム MIME 受け渡しと move の発行）を守る。
 *  2. drop ターゲットの見た目が選択行とほぼ同じで、どこに落ちるか分からなかった。
 *     → dragover 中はアクセント色の 2px リングが付くことを検証する。
 *
 * 共有モック（tauri-mock）はファイルを持たないため、この spec だけ
 * read_dir / move_item を差し替えた自前のモックを重ねる。
 */
const DIR = "/home/user/work";

const installFsMock = () => {
  const entry = (name: string, isDir: boolean) => ({
    name,
    path: `/home/user/work/${name}`,
    isDir,
    isSymlink: false,
    isHidden: false,
    size: isDir ? 0 : 1234,
    modified: 1_750_000_000,
    extension: isDir ? null : name.split(".").pop() ?? null,
  });
  const w = window as unknown as Record<string, unknown>;
  (w as { __moves?: unknown[] }).__moves = [];

  const install = () => {
    const internals = window.__TAURI_INTERNALS__ as
      | { invoke: (c: string, a?: unknown) => Promise<unknown>; __fsPatched?: boolean }
      | undefined;
    if (!internals || internals.__fsPatched) return false;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: unknown) => {
      if (cmd === "read_dir") {
        return Promise.resolve({
          path: "/home/user/work",
          entries: [entry("dest", true), entry("note.txt", false)],
        });
      }
      if (cmd === "path_exists") return Promise.resolve(false);
      if (cmd === "paths_exist") return Promise.resolve([]);
      if (cmd === "move_item") {
        (window as unknown as { __moves: unknown[] }).__moves.push(args);
        return Promise.resolve(null);
      }
      return orig(cmd, args);
    };
    internals.__fsPatched = true;
    return true;
  };
  if (!install()) {
    const timer = setInterval(() => install() && clearInterval(timer), 5);
    setTimeout(() => clearInterval(timer), 5000);
  }
};

/** パスバーへ直接入力して目的のディレクトリを開く。 */
async function openDir(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  // パスバーの input は非アクティブ時 display:none。まず親のバーを押して入力モードにする。
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(DIR);
  await pathInput.press("Enter");
  await expect(page.locator("[data-name-cell]", { hasText: /^dest$/ })).toBeVisible();
}

test.describe("file drag and drop", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFsMock);
  });

  test("moves a file into a folder by dragging", async ({ page }) => {
    await openDir(page);

    const src = page.locator("[data-name-cell]", { hasText: /^note\.txt$/ }).first();
    const dst = page.locator("[data-name-cell]", { hasText: /^dest$/ }).first();
    await src.dragTo(dst);

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __moves: unknown[] }).__moves))
      .toEqual([{ src: `${DIR}/note.txt`, dest: `${DIR}/dest/note.txt`, overwrite: false }]);
  });

  test("marks the hovered folder with an accent ring while dragging", async ({ page }) => {
    await openDir(page);

    const src = page.locator("[data-name-cell]", { hasText: /^note\.txt$/ }).first();
    const dst = page.locator("[data-name-cell]", { hasText: /^dest$/ }).first();
    // 行本体（drop ハンドラと枠線が付く要素）は data-name-cell の親。
    const dstRow = dst.locator("xpath=..");

    const before = await dstRow.evaluate((el) => getComputedStyle(el).outlineWidth);

    const s = (await src.boundingBox())!;
    const d = (await dst.boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 - 12, { steps: 4 });
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 10 });

    // ドラッグ中: 2px のアクセントリングが出る
    await expect.poll(() => dstRow.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe("2px");

    await page.mouse.up();
    // ドロップ後: リングは消える
    await expect.poll(() => dstRow.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(before);
  });
});
