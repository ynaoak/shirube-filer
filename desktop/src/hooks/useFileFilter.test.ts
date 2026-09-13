import { describe, expect, it } from "vitest";
import { parseExtQuery } from "./useFileFilter";

describe("parseExtQuery（拡張子検索の判定）", () => {
  it("*.md 形式は拡張子検索", () => {
    expect(parseExtQuery("*.md")).toBe("md");
    expect(parseExtQuery("*.JPG")).toBe("jpg");
    expect(parseExtQuery(" *.tar.gz ")).toBe("tar.gz");
  });

  it("ext: 形式は拡張子検索（ドット付きも許容）", () => {
    expect(parseExtQuery("ext:md")).toBe("md");
    expect(parseExtQuery("ext:.md")).toBe("md");
  });

  it("素の .md はドットファイル検索を壊さないため部分一致のまま", () => {
    expect(parseExtQuery(".md")).toBeNull();
    expect(parseExtQuery(".git")).toBeNull();
  });

  it("通常のファイル名検索は対象外", () => {
    expect(parseExtQuery("readme")).toBeNull();
    expect(parseExtQuery("report.pdf")).toBeNull();
    expect(parseExtQuery("")).toBeNull();
    expect(parseExtQuery("*.")).toBeNull();
    expect(parseExtQuery("ext:")).toBeNull();
  });
});
