import { describe, it, expect } from "vitest";
import { migrateBrandStorage } from "./brandMigration";

/** テスト用の最小 Storage 実装（Map ベース）。 */
function makeStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

describe("migrateBrandStorage", () => {
  it("旧キーを新キーへ移し、テーマ ID プレフィックスを書き換える", () => {
    const s = makeStorage({
      "kakashi-theme": "kakashi-dark",
      "kakashi-language": "ja",
      "kakashi-ui-settings": JSON.stringify({ themeId: "kakashi-light", language: "en" }),
    });

    migrateBrandStorage(s);

    // 新キーに移行され、テーマ ID も shirube- に変換される
    expect(s.getItem("shirube-theme")).toBe("shirube-dark");
    expect(s.getItem("shirube-language")).toBe("ja");
    expect(JSON.parse(s.getItem("shirube-ui-settings") as string)).toEqual({
      themeId: "shirube-light",
      language: "en",
    });

    // 旧キーは除去される
    expect(s.getItem("kakashi-theme")).toBeNull();
    expect(s.getItem("kakashi-language")).toBeNull();
    expect(s.getItem("kakashi-ui-settings")).toBeNull();
  });

  it("user-presets の入れ子テーマ ID も書き換える", () => {
    const s = makeStorage({
      "kakashi-user-presets": JSON.stringify([
        { id: "user-1", name: "X", mode: "dark", base: "kakashi-dark" },
      ]),
    });

    migrateBrandStorage(s);

    const presets = JSON.parse(s.getItem("shirube-user-presets") as string);
    expect(presets[0].base).toBe("shirube-dark");
    expect(presets[0].id).toBe("user-1"); // user-* は影響を受けない
  });

  it("新キーが既にあれば上書きせず、旧キーのみ除去する（冪等）", () => {
    const s = makeStorage({
      "kakashi-theme": "kakashi-dark",
      "shirube-theme": "shirube-light", // ユーザーが新版で設定済み
    });

    migrateBrandStorage(s);

    expect(s.getItem("shirube-theme")).toBe("shirube-light"); // 既存値を尊重
    expect(s.getItem("kakashi-theme")).toBeNull();

    // 二度目の実行でも何も壊れない
    migrateBrandStorage(s);
    expect(s.getItem("shirube-theme")).toBe("shirube-light");
  });

  it("移行済み（新キーのみ）の状態では何もしない", () => {
    const s = makeStorage({
      "shirube-theme": "shirube-dark",
      "shirube-language": "ja",
    });

    migrateBrandStorage(s);

    expect(s.getItem("shirube-theme")).toBe("shirube-dark");
    expect(s.getItem("shirube-language")).toBe("ja");
  });

  it("何も保存されていなくても安全", () => {
    const s = makeStorage();
    expect(() => migrateBrandStorage(s)).not.toThrow();
    expect(s.length).toBe(0);
  });
});
