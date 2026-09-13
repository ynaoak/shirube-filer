import { test, expect } from "./support/fixtures";

/**
 * プレビューパネルの編集 → 保存。
 *
 * リグレッション対象:
 *  1. 保存してもプレビューが古いまま。content を再読込するきっかけが FS ウォッチャー
 *     （FS_DIR_CHANGED）だけで、しかも編集中は編集内容を壊さないよう意図的に
 *     無視しているため、保存 → 編集モードを閉じる、の順だと誰も content を
 *     更新せず保存前の本文が表示され続けた。
 *  2. プレビューは maxBytes: 65536 で打ち切って読むのに、その本文をそのまま
 *     エディタの初期値にしていたため、64KB を超えるファイルを保存すると
 *     以降が消えていた（write_text_file は渡した文字列で全置換するため）。
 *     編集に入るときは全文を読み直す。
 */
const DIR = "/home/user/work";
const BIG_MARKER = "TAIL-MUST-SURVIVE";
/** プレビューの打ち切り上限（PreviewPanel の read_text_file maxBytes） */
const PREVIEW_CAP = 65536;

const installFsMock = () => {
  const entry = (name: string, size: number) => ({
    name,
    path: `/home/user/work/${name}`,
    isDir: false,
    isSymlink: false,
    isHidden: false,
    size,
    modified: 1_750_000_000,
    extension: name.split(".").pop() ?? null,
  });
  const files: Record<string, string> = {
    "/home/user/work/note.txt": "original line 1\noriginal line 2",
    "/home/user/work/big.txt": "x".repeat(70000) + "\nTAIL-MUST-SURVIVE",
  };
  const w = window as unknown as Record<string, unknown>;
  w.__files = files;
  w.__reads = [] as Array<{ path?: string; maxBytes?: number }>;

  const install = () => {
    const internals = window.__TAURI_INTERNALS__ as
      | { invoke: (c: string, a?: unknown) => Promise<unknown>; __fsPatched?: boolean }
      | undefined;
    if (!internals || internals.__fsPatched) return false;
    const orig = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as { path?: string; maxBytes?: number; content?: string };
      // プレビューを自動表示にしないとパネルが開かない（既定は false）
      if (cmd === "load_ui_settings") return Promise.resolve(JSON.stringify({ autoShowPreview: true }));
      if (cmd === "read_dir") {
        return Promise.resolve({
          path: "/home/user/work",
          entries: [
            entry("note.txt", files["/home/user/work/note.txt"].length),
            entry("big.txt", files["/home/user/work/big.txt"].length),
          ],
        });
      }
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: (files[a.path ?? ""] ?? "").length });
      }
      // 実装と同じく maxBytes で「打ち切って」返すのが肝。
      if (cmd === "read_text_file") {
        (w.__reads as Array<unknown>).push({ path: a.path, maxBytes: a.maxBytes });
        const full = files[a.path ?? ""] ?? "";
        return Promise.resolve(full.slice(0, a.maxBytes ?? full.length));
      }
      if (cmd === "write_text_file") {
        files[a.path ?? ""] = a.content ?? "";
        return Promise.resolve(null);
      }
      if (cmd === "path_exists") return Promise.resolve(false);
      if (cmd === "paths_exist") return Promise.resolve([]);
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

type Page = import("@playwright/test").Page;

const editBtn = (page: Page) => page.getByTitle(/^編集$|^Edit$/).first();
// 編集中は同じボタンの title が「プレビューに戻る」に変わる
const backBtn = (page: Page) => page.getByTitle(/プレビューに戻る|Back to Preview/).first();
const saveBtn = (page: Page) => page.getByTitle(/^保存 |^Save /).first();

/** 一覧を開いて対象ファイルを選び、プレビューを表示する。 */
async function openPreview(page: Page, name: string) {
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(DIR);
  await pathInput.press("Enter");
  await page.locator("[data-name-cell]", { hasText: new RegExp(`^${name.replace(".", "\\.")}$`) }).first().click();
  await expect(editBtn(page)).toBeVisible({ timeout: 15_000 });
}

/** Monaco（遅延ロード）が描画されるまで待つ。 */
async function waitForEditor(page: Page) {
  await expect(page.locator(".monaco-editor .view-lines")).toBeVisible({ timeout: 30_000 });
}

/** Monaco の末尾に文字列を追記する。
 *  window.monaco は公開されておらず、Monaco 0.55 は EditContext API
 *  （div.native-edit-context）を使うため、実際のキー操作で行う。
 *  全選択（⌘A）は Playwright のキーイベントからは効かないので、
 *  「末尾へ移動して追記」で内容を変える。 */
async function appendToEditor(page: Page, value: string) {
  await waitForEditor(page);
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(value, { delay: 20 });
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(value);
}

test.describe("preview editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFsMock);
  });

  test("preview shows the saved text after leaving edit mode", async ({ page }) => {
    const ADDED = "EDITED-BY-TEST";
    await openPreview(page, "note.txt");
    await expect(page.locator("body")).toContainText("original line 1");
    await expect(page.locator("body")).not.toContainText(ADDED);

    await editBtn(page).click();
    await appendToEditor(page, ADDED);
    await saveBtn(page).click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __files: Record<string, string> }).__files["/home/user/work/note.txt"]))
      .toContain(ADDED);

    // 編集モードを閉じる → 保存後の内容が出る（ここが退行箇所。修正前は
    // 保存前の本文がそのまま残っていた）
    await backBtn(page).click();
    await expect(page.locator(".monaco-editor")).toHaveCount(0);
    await expect(page.locator("body")).toContainText(ADDED);
  });

  test("re-reads the whole file when entering edit mode", async ({ page }) => {
    await openPreview(page, "big.txt");
    // プレビュー自体は打ち切って読む
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __reads: Array<{ maxBytes?: number }> }).__reads))
      .toContainEqual({ path: "/home/user/work/big.txt", maxBytes: PREVIEW_CAP });

    await editBtn(page).click();
    await waitForEditor(page);

    // 編集に入るときは打ち切り上限より大きい maxBytes で読み直す（ここが退行箇所）
    const reads = await page.evaluate(() => (window as unknown as { __reads: Array<{ maxBytes?: number }> }).__reads);
    expect(reads.some((r) => (r.maxBytes ?? 0) > PREVIEW_CAP)).toBe(true);
  });

  test("saving a file larger than the preview cap keeps the tail intact", async ({ page }) => {
    await openPreview(page, "big.txt");
    await editBtn(page).click();
    await waitForEditor(page);

    // 一切編集せずそのまま保存しても、64KB 以降が消えてはいけない
    await saveBtn(page).click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __files: Record<string, string> }).__files["/home/user/work/big.txt"]))
      .toContain(BIG_MARKER);
  });
});
