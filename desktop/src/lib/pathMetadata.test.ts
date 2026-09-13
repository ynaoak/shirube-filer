import { describe, it, expect } from "vitest";
import { remapPath, remapPathMap, removePathsFromMap } from "./pathMetadata";

describe("remapPath", () => {
  it("リネームされた本人を読み替える", () => {
    expect(remapPath("/a/old.txt", "/a/old.txt", "/a/new.txt")).toBe("/a/new.txt");
  });

  it("移動したフォルダの配下も読み替える", () => {
    expect(remapPath("/a/dir/x/y.txt", "/a/dir", "/b/dir")).toBe("/b/dir/x/y.txt");
  });

  it("無関係なパスはそのまま", () => {
    expect(remapPath("/other/x.txt", "/a/dir", "/b/dir")).toBe("/other/x.txt");
  });

  it("前方一致しただけの兄弟を巻き込まない", () => {
    // "/a/foo" を動かしても "/a/foobar" は別物
    expect(remapPath("/a/foobar", "/a/foo", "/b/foo")).toBe("/a/foobar");
    expect(remapPath("/a/foobar.txt", "/a/foo", "/b/foo")).toBe("/a/foobar.txt");
  });

  it("Windows のバックスラッシュ区切りでも配下を辿れる", () => {
    expect(remapPath("C:\\a\\dir\\x.txt", "C:\\a\\dir", "C:\\b\\dir")).toBe("C:\\b\\dir\\x.txt");
    expect(remapPath("C:\\a\\dirs\\x.txt", "C:\\a\\dir", "C:\\b\\dir")).toBe("C:\\a\\dirs\\x.txt");
  });
});

describe("remapPathMap", () => {
  it("該当が無ければ同一参照を返す", () => {
    const map = { "/x/a.txt": ["tag"] };
    expect(remapPathMap(map, "/y/b.txt", "/y/c.txt")).toBe(map);
  });

  it("from と to が同じなら同一参照を返す", () => {
    const map = { "/x/a.txt": ["tag"] };
    expect(remapPathMap(map, "/x/a.txt", "/x/a.txt")).toBe(map);
  });

  it("リネームでキーを付け替える（元のキーは残さない）", () => {
    const map = { "/a/old.txt": ["重要"], "/a/keep.txt": ["別"] };
    expect(remapPathMap(map, "/a/old.txt", "/a/new.txt")).toEqual({
      "/a/new.txt": ["重要"],
      "/a/keep.txt": ["別"],
    });
  });

  it("フォルダ移動で配下をまとめて付け替える", () => {
    const map = {
      "/a/dir": "#ef4444",
      "/a/dir/x.txt": "#22c55e",
      "/a/dir/sub/y.txt": "#3b82f6",
      "/a/other.txt": "#eab308",
    };
    expect(remapPathMap(map, "/a/dir", "/b/dir")).toEqual({
      "/b/dir": "#ef4444",
      "/b/dir/x.txt": "#22c55e",
      "/b/dir/sub/y.txt": "#3b82f6",
      "/a/other.txt": "#eab308",
    });
  });

  it("上書き移動では移動してきた側の値を優先する", () => {
    const map = { "/a/x.txt": ["移動元"], "/b/x.txt": ["上書きされる"] };
    expect(remapPathMap(map, "/a/x.txt", "/b/x.txt")).toEqual({ "/b/x.txt": ["移動元"] });
  });
});

describe("removePathsFromMap", () => {
  it("該当が無ければ同一参照を返す", () => {
    const map = { "/x/a.txt": ["tag"] };
    expect(removePathsFromMap(map, ["/y/b.txt"])).toBe(map);
    expect(removePathsFromMap(map, [])).toBe(map);
  });

  it("削除したファイルの項目を消す", () => {
    const map = { "/a/gone.txt": ["重要"], "/a/keep.txt": ["別"] };
    expect(removePathsFromMap(map, ["/a/gone.txt"])).toEqual({ "/a/keep.txt": ["別"] });
  });

  it("フォルダを消すと配下もまとめて消える", () => {
    const map = {
      "/a/dir": "#ef4444",
      "/a/dir/x.txt": "#22c55e",
      "/a/dir/sub/y.txt": "#3b82f6",
      "/a/other.txt": "#eab308",
    };
    expect(removePathsFromMap(map, ["/a/dir"])).toEqual({ "/a/other.txt": "#eab308" });
  });

  it("前方一致しただけの兄弟は消さない", () => {
    const map = { "/a/foo": ["x"], "/a/foobar": ["y"], "/a/foobar.txt": ["z"] };
    expect(removePathsFromMap(map, ["/a/foo"])).toEqual({
      "/a/foobar": ["y"],
      "/a/foobar.txt": ["z"],
    });
  });

  it("複数まとめて削除できる", () => {
    const map = { "/a/1.txt": ["a"], "/a/2.txt": ["b"], "/a/3.txt": ["c"] };
    expect(removePathsFromMap(map, ["/a/1.txt", "/a/3.txt"])).toEqual({ "/a/2.txt": ["b"] });
  });
});
