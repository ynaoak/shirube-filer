import { test, expect } from "./support/fixtures";
import { THEMES as THEME_DEFS } from "../src/store/themeStore";

/**
 * アクセント色の上に載る文字色（--kf-accent-fg）の可読性。
 *
 * リグレッション対象: --kf-accent-fg を定義しているのは一部のテーマだけで、
 * 未定義のテーマに切り替えても前のテーマ（や :root の既定 #08334A）の濃色が
 * 残り続けていた。その結果、彩度の高いアクセントの上に黒に近い文字が乗り、
 * 選択中のフィルタチップなどが読めなくなっていた。
 *
 * ここでは「どのテーマでも accent-fg が accent に対して 3:1 以上」を担保する。
 */
// テーマ定義から直接引く。テーマが増えたときに一覧を書き足し忘れて
// 検査から漏れる（＝今回の退行がすり抜ける）のを防ぐ。
const THEMES = THEME_DEFS.map((t) => t.id);

/** ブラウザ側で計算する WCAG コントラスト比。 */
const readVars = () => {
  const s = getComputedStyle(document.documentElement);
  const norm = (v: string) => {
    const t = v.trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(t)) return t;
    const m = t.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b] = m[1].split(",").map((x) => parseInt(x.trim(), 10));
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  };
  const accent = norm(s.getPropertyValue("--kf-accent"));
  const fg = norm(s.getPropertyValue("--kf-accent-fg"));
  if (!accent || !fg) return { accent, fg, ratio: 0 };
  const lum = (hex: string) => {
    const ch = (i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(1)) + 0.0722 * lin(ch(2));
  };
  const a = lum(accent), b = lum(fg);
  return { accent, fg, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
};

test.describe("accent foreground contrast", () => {
  for (const theme of THEMES) {
    test(`${theme}: accent-fg stays readable on the accent`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("shirube-theme", t), theme);
      await page.goto("/");
      await expect(page.locator("#root")).not.toBeEmpty();

      const { accent, fg, ratio } = await page.evaluate(readVars);
      expect(accent, "accent が取れていること").toBeTruthy();
      expect(fg, "accent-fg が必ず設定されていること").toBeTruthy();
      expect(ratio, `${theme}: ${fg} on ${accent}`).toBeGreaterThanOrEqual(3);
    });
  }

  test("switching themes refreshes accent-fg instead of leaving the old one", async ({ page }) => {
    // 淡いアクセント（濃色の文字）→ 濃いアクセント へ切り替えても持ち越さない。
    // ここでは addInitScript を使わない（reload のたびに再実行され、
    // テスト中に切り替えたテーマを上書きしてしまうため）。
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("shirube-theme", "shirube-dark"));
    await page.reload();
    await expect(page.locator("#root")).not.toBeEmpty();
    const before = await page.evaluate(readVars);
    expect(before.fg?.toLowerCase()).toBe("#08334a");

    await page.evaluate(() => localStorage.setItem("shirube-theme", "dracula"));
    await page.reload();
    await expect(page.locator("#root")).not.toBeEmpty();

    const after = await page.evaluate(readVars);
    expect(after.accent?.toLowerCase()).toBe("#8b5cf6");
    expect(after.fg?.toLowerCase()).toBe("#ffffff");
    expect(after.ratio).toBeGreaterThanOrEqual(3);
  });
});

/**
 * 選択行（ツリー・一覧）の塗りと、その上に載るものの可読性。
 *
 * リグレッション対象: 選択行はアクセントをそのまま敷いていた。アクセントは
 * テーマ固定ではなく（ユーザー定義テーマ・OS アクセント連動がある）、淡い色に
 * なると白い文字とフォルダアイコンが沈む。既定の Shirube Dark（#7DD3FC）では
 * 白とのコントラストが 1.67:1 しかなかった。
 *
 * いまはアクセントを黒側へ 30% まで寄せた --kf-sel-bg を敷いている。ここでは
 * 「どのテーマでも白文字が 4.5:1 以上、種別アイコンの色が 3:1 以上」を担保する。
 * 混合率を上げると白は良くなるがアイコンが沈み、下げるとその逆になるため、
 * 片方だけ見ていると気付かずに壊れる。
 */
const readSelectionContrast = () => {
  // color-mix() は getPropertyValue では解決されないので、一度要素に適用して
  // 計算後の色を読む。ブラウザは color(srgb 0-1) 形式で返すことがある。
  // 選択行の中では種別色トークンが差し替わる。実際に使われる文脈と同じ
  // 条件で解決しないと、根元の（ライトテーマ用の濃い）色を測ってしまう。
  const probe = document.createElement("div");
  probe.setAttribute("role", "option");
  probe.setAttribute("aria-selected", "true");
  document.body.appendChild(probe);
  const resolve = (expr: string): [number, number, number] | null => {
    probe.style.backgroundColor = "";
    probe.style.backgroundColor = expr;
    const c = getComputedStyle(probe).backgroundColor;
    const n = (c.match(/-?\d*\.?\d+/g) || []).slice(0, 3).map(Number);
    if (n.length < 3) return null;
    return (c.startsWith("color(") ? n.map((v) => v * 255) : n) as [number, number, number];
  };
  const lum = (c: [number, number, number]) => {
    const lin = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const bg = resolve("var(--kf-sel-bg)");
  const fg = resolve("var(--kf-sel-fg)");
  if (!bg || !fg) {
    document.body.removeChild(probe);
    return { text: 0, icon: 0 };
  }
  // 一覧のファイル種別アイコンに使われる色。どれかが沈むと種別が読めない。
  const iconVars = [
    "--kf-ft-image", "--kf-ft-video", "--kf-ft-audio", "--kf-ft-archive",
    "--kf-ft-code", "--kf-text-secondary", "--kf-text-muted",
  ];
  let icon = Infinity;
  for (const v of iconVars) {
    const c = resolve(`var(${v})`);
    if (c) icon = Math.min(icon, ratio(bg, c));
  }
  document.body.removeChild(probe);
  return { text: ratio(bg, fg), icon: icon === Infinity ? 0 : icon };
};

test.describe("selection row contrast", () => {
  for (const theme of THEMES) {
    test(`${theme}: white text and type icons stay readable on the selection fill`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("shirube-theme", t), theme);
      await page.goto("/");
      await expect(page.locator("#root")).not.toBeEmpty();

      const { text, icon } = await page.evaluate(readSelectionContrast);
      // 本文の基準。選択行の文字とフォルダアイコンは白で描かれる。
      expect(text, `${theme}: 白文字が選択塗りの上で沈んでいる`).toBeGreaterThanOrEqual(4.5);
      // 非テキスト（アイコン）の基準。種別色は中間調なので塗りを濃くしすぎると沈む。
      expect(icon, `${theme}: 種別アイコンが選択塗りの上で沈んでいる`).toBeGreaterThanOrEqual(3);
    });
  }
});

/**
 * ステータス色（トーストの左帯・アイコン・件数表示）の可読性。
 *
 * リグレッション対象: --kf-success / --kf-warning は明るい緑・橙を固定で置いて
 * いた。白基調のライト系テーマでは背景と明るさが近く、全 17 テーマ中 13 テーマで
 * 非テキストの 3:1 すら割っていた（#22c55e は Shirube Light の bg-secondary に
 * 対して 2.11:1）。組み込みサーバー起動の成功トーストで、左帯とアイコンが
 * ほとんど見えない状態だった。
 *
 * いまはライト/ダークで明るさを切り替える。ここでは「どのテーマでもトーストの
 * 背景（bg-secondary）に対して 4.5:1 以上」を担保する。帯とアイコンは非テキスト
 * なので 3:1 で足りるが、同じトークンを文字色にも使う（件数表示・危険操作ボタン）
 * ため本文基準で固定する。
 *
 * info はアクセントの色味を使う。アクセントは淡いこともある（ユーザー定義テーマ・
 * OS アクセント連動）ため、テキスト色側へ寄せて明るさを揃えている。寄せ方を
 * 弱めると淡いテーマで沈み、強めると色味が消えるので、ここで下限を止める。
 */
const readStatusContrast = () => {
  // color-mix() は getPropertyValue では解決されないため、一度要素に当てて
  // 計算後の色を読む。ブラウザは color(srgb 0-1) 形式で返すことがある。
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  const resolve = (expr: string): [number, number, number] | null => {
    probe.style.backgroundColor = "";
    probe.style.backgroundColor = expr;
    const c = getComputedStyle(probe).backgroundColor;
    const n = (c.match(/-?\d*\.?\d+/g) || []).slice(0, 3).map(Number);
    if (n.length < 3) return null;
    return (c.startsWith("color(") ? n.map((v) => v * 255) : n) as [number, number, number];
  };
  const lum = (c: [number, number, number]) => {
    const lin = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // トーストの地色。左帯・アイコン・文字はこの上に乗る。
  const bg = resolve("var(--kf-bg-secondary)");
  const out: Record<string, number> = {};
  for (const name of ["success", "warning", "error", "info"]) {
    const c = resolve(`var(--kf-${name})`);
    out[name] = bg && c ? ratio(bg, c) : 0;
  }
  document.body.removeChild(probe);
  return out;
};

test.describe("status color contrast", () => {
  for (const theme of THEMES) {
    test(`${theme}: status colors stay readable on the toast surface`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("shirube-theme", t), theme);
      await page.goto("/");
      await expect(page.locator("#root")).not.toBeEmpty();

      const ratios = await page.evaluate(readStatusContrast);
      for (const [name, ratio] of Object.entries(ratios)) {
        expect(ratio, `${theme}: --kf-${name} がトーストの地色に沈んでいる`).toBeGreaterThanOrEqual(
          4.5
        );
      }
    });
  }
});
