import { test, expect } from "./support/fixtures";

/**
 * ドラッグ中にカーソルへ追従する画像。
 *
 * 既定では WebView が「掴んだ行のスクリーンショット」を出すため、一覧幅の
 * 四角い枠が付いてくる。setDragImage() で種別アイコン＋名前のカードに
 * 差し替えていることを検証する。
 *
 * 注意: 実際に描かれる絵は OS のコンポジタが出すのでスクリーンショットには
 * 写らない。ここでは「setDragImage に何を渡したか」を捕まえて中身を見る。
 */
const DIR = "/home/user/work";

const installMock = () => {
  const mk = (name: string, isDir: boolean) => ({
    name,
    path: `/home/user/work/${name}`,
    isDir,
    isSymlink: false,
    isHidden: false,
    size: 100,
    modified: 1_750_000_000,
    extension: isDir ? null : name.split(".").pop() ?? null,
  });
  const entries = [mk("photo.png", false), mk("notes.md", false), mk("stuff", true)];

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

/** setDragImage に渡された要素を記録する。 */
const spyDragImage = () => {
  const w = window as unknown as Record<string, unknown>;
  w.__dragImages = [];
  const proto = DataTransfer.prototype as DataTransfer & {
    setDragImage: (el: Element, x: number, y: number) => void;
  };
  const orig = proto.setDragImage;
  proto.setDragImage = function (el: Element, x: number, y: number) {
    (w.__dragImages as unknown[]).push({
      html: (el as HTMLElement).outerHTML,
      isFileDragImage: (el as HTMLElement).dataset?.fileDragImage === "true",
      iconName: el.querySelector<HTMLElement>("[data-icon-name]")?.dataset.iconName ?? null,
      text: (el as HTMLElement).innerText || (el as HTMLElement).textContent,
      count: el.querySelector<HTMLElement>("[data-drag-count]")?.dataset.dragCount ?? null,
      // 立体アイコンは図形そのものが絵柄なので、輪郭を並べて一覧と突き合わせる。
      paths: Array.from(el.querySelectorAll("svg path")).map((p) => p.getAttribute("d")),
      offset: { x, y },
      attached: document.body.contains(el),
    });
    return orig.call(this, el, x, y);
  };
};

/** アイコンセットを立体アイコンにした状態でアプリを起動させる。 */
const useDimensionalIcons = () => {
  localStorage.setItem("shirube-ui-settings", JSON.stringify({ iconSet: "dimensional" }));
};

type Page = import("@playwright/test").Page;
const rows = (page: Page) => page.locator("[data-name-cell]");
const shots = (page: Page) =>
  page.evaluate(() => (window as unknown as { __dragImages: Array<Record<string, unknown>> }).__dragImages);

async function openDir(page: Page, dimensional = false) {
  await page.addInitScript(installMock);
  await page.addInitScript(spyDragImage);
  if (dimensional) await page.addInitScript(useDimensionalIcons);
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  const pathInput = page.locator("input").first();
  await pathInput.locator("xpath=..").click();
  await expect(pathInput).toBeVisible();
  await pathInput.fill(DIR);
  await pathInput.press("Enter");
  await expect(rows(page)).toHaveCount(3);
}

test.describe("drag image", () => {
  test("uses the file type icon instead of the default row snapshot", async ({ page }) => {
    await openDir(page);
    await rows(page).filter({ hasText: "photo.png" }).dragTo(rows(page).filter({ hasText: "stuff" }));

    const captured = await shots(page);
    expect(captured.length).toBeGreaterThan(0);
    const first = captured[0];
    expect(first.isFileDragImage, "独自のドラッグ画像が渡されている").toBe(true);
    expect(first.iconName, "png なので画像アイコン").toBe("image");
    expect(String(first.text)).toContain("photo.png");
    // 単一選択では件数バッジを出さない
    expect(first.count).toBeNull();
    // スナップショットを撮れるよう DOM に入っている必要がある
    expect(first.attached).toBe(true);
  });

  test("uses the folder icon when dragging a folder", async ({ page }) => {
    await openDir(page);
    await rows(page).filter({ hasText: "stuff" }).dragTo(rows(page).filter({ hasText: "notes.md" }));

    const [first] = await shots(page);
    expect(first.iconName).toBe("folder");
    expect(String(first.text)).toContain("stuff");
  });

  test("shows how many items are being dragged for a multi selection", async ({ page }) => {
    await openDir(page);
    await rows(page).filter({ hasText: "photo.png" }).click();
    await rows(page).filter({ hasText: "notes.md" }).click({ modifiers: ["ControlOrMeta"] });
    await rows(page).filter({ hasText: "notes.md" }).dragTo(rows(page).filter({ hasText: "stuff" }));

    const [first] = await shots(page);
    expect(first.count).toBe("2");
  });

  test("matches the icon set shown in the list when dimensional icons are selected", async ({ page }) => {
    await openDir(page, true);

    // 一覧側が立体アイコン（SVG）になっていることをまず確かめる。
    const rowIcon = rows(page).filter({ hasText: "photo.png" }).locator("xpath=..").locator("svg");
    await expect(rowIcon.first()).toBeAttached();
    const rowPaths = await rowIcon.first().evaluate((svg) =>
      Array.from(svg.querySelectorAll("path")).map((p) => p.getAttribute("d"))
    );
    expect(rowPaths.length).toBeGreaterThan(0);

    await rows(page).filter({ hasText: "photo.png" }).dragTo(rows(page).filter({ hasText: "stuff" }));

    const [first] = await shots(page);
    // Material Symbols のフォントアイコンではなく、一覧と同じ図形が入っている。
    expect(first.iconName, "立体アイコン選択時は Material のフォントアイコンを使わない").toBeNull();
    expect(first.paths).toEqual(rowPaths);
  });

  test("removes the temporary element after the drag starts", async ({ page }) => {
    await openDir(page);
    await rows(page).filter({ hasText: "photo.png" }).dragTo(rows(page).filter({ hasText: "stuff" }));

    // 画面外に置いた一時要素が残り続けないこと
    await expect.poll(() => page.locator("[data-file-drag-image]").count()).toBe(0);
  });
});
