import { describe, expect, it } from "vitest";
import { isMtpPath, planMtpTransfer } from "./mtp";

const IPHONE = "mtp://Apple iPhone/Internal Storage/202608_a/WQVJ0903.MP4";

describe("isMtpPath", () => {
  it("mtp:// で始まるパスだけを MTP と判定する", () => {
    expect(isMtpPath(IPHONE)).toBe(true);
    expect(isMtpPath("D:\\videos")).toBe(false);
    expect(isMtpPath("/home/user")).toBe(false);
  });
});

describe("planMtpTransfer（MTP が絡む D&D / 貼り付けの振り分け）", () => {
  it("MTP → ローカル: 取り出し（ダウンロード）に振り分ける", () => {
    const plan = planMtpTransfer([IPHONE], "D:\\videos");
    expect(plan.unsupported).toBe(false);
    expect(plan.remaining).toEqual([]);
    expect(plan.downloads).toEqual([
      { src: IPHONE, dest: "D:\\videos\\WQVJ0903.MP4" },
    ]);
  });

  it("宛先がドライブ直下（末尾区切りあり）でも区切りが重複しない", () => {
    expect(planMtpTransfer([IPHONE], "D:\\").downloads[0].dest).toBe("D:\\WQVJ0903.MP4");
  });

  it("Unix の宛先では / 区切りになる", () => {
    expect(planMtpTransfer([IPHONE], "/home/user").downloads[0].dest).toBe("/home/user/WQVJ0903.MP4");
  });

  it("宛先が MTP なら書き込み非対応として弾く", () => {
    const plan = planMtpTransfer(["D:\\a.txt"], "mtp://Apple iPhone/Internal Storage");
    expect(plan.unsupported).toBe(true);
    expect(plan.downloads).toEqual([]);
    expect(plan.remaining).toEqual([]);
  });

  it("MTP 同士（端末内の貼り付け）も書き込み非対応として弾く", () => {
    const plan = planMtpTransfer([IPHONE], "mtp://Apple iPhone/Internal Storage/DCIM");
    expect(plan.unsupported).toBe(true);
    expect(plan.downloads).toEqual([]);
  });

  it("MTP を含まない転送は通常の移動/コピーとしてそのまま通す", () => {
    const plan = planMtpTransfer(["D:\\a.txt", "D:\\b.txt"], "D:\\dest");
    expect(plan.unsupported).toBe(false);
    expect(plan.downloads).toEqual([]);
    expect(plan.remaining).toEqual(["D:\\a.txt", "D:\\b.txt"]);
  });

  it("MTP とローカルが混在する場合は取り出しと移動に分ける", () => {
    const plan = planMtpTransfer([IPHONE, "D:\\a.txt"], "D:\\dest");
    expect(plan.downloads).toHaveLength(1);
    expect(plan.remaining).toEqual(["D:\\a.txt"]);
  });

  it("名前に空白や日本語が含まれていても末尾のファイル名だけを取り出し先にする", () => {
    const src = "mtp://Apple iPhone/Internal Storage/202608_a/CHMO 9984 写真.PNG";
    expect(planMtpTransfer([src], "D:\\写真").downloads[0].dest).toBe("D:\\写真\\CHMO 9984 写真.PNG");
  });
});
