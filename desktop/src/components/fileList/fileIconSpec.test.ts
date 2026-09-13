import { describe, it, expect } from "vitest";
import { fileIconSpec, fileIconKind } from "./fileIconSpec";
import type { FileEntry } from "../../types/fs";

const entry = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/x/${name}`,
  isDir: false,
  isSymlink: false,
  isHidden: false,
  size: 0,
  modified: null,
  extension: name.includes(".") ? name.split(".").pop()! : null,
  ...over,
});

describe("fileIconSpec", () => {
  it("フォルダはアクセント色のフォルダアイコン", () => {
    expect(fileIconSpec(entry("dir", { isDir: true, extension: null }))).toEqual({
      name: "folder",
      color: "var(--kf-accent)",
    });
  });

  it("シンボリックリンクはフォルダ判定より後でもリンクアイコン", () => {
    expect(fileIconSpec(entry("l", { isSymlink: true, extension: null })).name).toBe("link");
  });

  it("拡張子で種別アイコンを出し分ける", () => {
    expect(fileIconSpec(entry("a.png")).name).toBe("image");
    expect(fileIconSpec(entry("a.mp4")).name).toBe("movie");
    expect(fileIconSpec(entry("a.mp3")).name).toBe("music_note");
    expect(fileIconSpec(entry("a.zip")).name).toBe("folder_zip");
    expect(fileIconSpec(entry("a.pdf")).name).toBe("picture_as_pdf");
    expect(fileIconSpec(entry("a.ts")).name).toBe("code");
    expect(fileIconSpec(entry("a.xlsx")).name).toBe("table");
    expect(fileIconSpec(entry("a.md")).name).toBe("article");
  });

  it("拡張子の大文字小文字を区別しない", () => {
    expect(fileIconSpec(entry("A.PNG")).name).toBe("image");
    expect(fileIconSpec(entry("A.Zip")).name).toBe("folder_zip");
  });

  it("未知の拡張子・拡張子なしは既定アイコン", () => {
    expect(fileIconSpec(entry("a.unknownext")).name).toBe("description");
    expect(fileIconSpec(entry("README", { extension: null })).name).toBe("description");
  });

  it("フォルダは拡張子より優先される（例: my.zip という名前のフォルダ）", () => {
    expect(fileIconSpec(entry("my.zip", { isDir: true })).name).toBe("folder");
  });
});

describe("fileIconKind（立体アイコンの種別判定）", () => {
  it("フォルダ・シンボリックリンクを先に判定する", () => {
    // 拡張子つきのフォルダでも種別はフォルダ（例: my.app/）
    expect(fileIconKind(entry("my.pdf", { isDir: true }))).toBe("folder");
    expect(fileIconKind(entry("link.txt", { isSymlink: true }))).toBe("link");
  });

  it("Office 系は種類ごとに分かれる", () => {
    expect(fileIconKind(entry("a.docx"))).toBe("word");
    expect(fileIconKind(entry("a.xlsx"))).toBe("excel");
    expect(fileIconKind(entry("a.pptx"))).toBe("ppt");
    // csv は表計算として扱う
    expect(fileIconKind(entry("a.csv"))).toBe("excel");
  });

  it("メディア・アーカイブ・コードを見分ける", () => {
    expect(fileIconKind(entry("a.png"))).toBe("image");
    expect(fileIconKind(entry("a.mp4"))).toBe("video");
    expect(fileIconKind(entry("a.mp3"))).toBe("audio");
    expect(fileIconKind(entry("a.zip"))).toBe("archive");
    expect(fileIconKind(entry("a.pdf"))).toBe("pdf");
    expect(fileIconKind(entry("a.ts"))).toBe("code");
    expect(fileIconKind(entry("a.md"))).toBe("text");
  });

  it("大文字の拡張子も同じ種別になる", () => {
    expect(fileIconKind(entry("A.PNG"))).toBe("image");
    expect(fileIconKind(entry("A.PDF"))).toBe("pdf");
  });

  it("未知の拡張子・拡張子なしは generic", () => {
    expect(fileIconKind(entry("a.unknownext"))).toBe("generic");
    expect(fileIconKind(entry("Makefile", { extension: null }))).toBe("generic");
  });
});
