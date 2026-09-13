import { describe, it, expect } from "vitest";
import { readableTextOn, contrastRatio } from "./contrastColor";

describe("readableTextOn", () => {
  it("彩度の高い中間調のアクセントでは白を選ぶ", () => {
    // 以前はコントラスト最大化で濃色になり「色付き背景に黒文字」になっていた色たち
    for (const accent of [
      "#3b82f6", // dark テーマ
      "#8B5CF6", // dracula
      "#5E81AC", // nord
      "#3D9900", // monokai
      "#3B82C4", // one-dark
      "#4A7FD4", // tokyo-night
      "#427B58", // gruvbox
      "#0969da", // github-light
      "#268bd2", // solarized-dark
      "#2aa198", // solarized-light
      "#2563eb", // light
      "#0369A1", // shirube-light
    ]) {
      expect(readableTextOn(accent), accent).toBe("#FFFFFF");
    }
  });

  it("淡いアクセントでは白が読めないので濃色を選ぶ", () => {
    for (const accent of [
      "#7DD3FC", // shirube-dark（既定）— 白だと 1.7:1 しかない
      "#5D9FE8", // catppuccin
      "#00aaff", // high-contrast
    ]) {
      expect(readableTextOn(accent), accent).toBe("#0B1220");
    }
  });

  it("選んだ文字色は必ず 3:1 以上のコントラストになる", () => {
    for (const accent of ["#7DD3FC", "#3b82f6", "#8B5CF6", "#00aaff", "#5D9FE8", "#427B58"]) {
      expect(contrastRatio(readableTextOn(accent), accent), accent).toBeGreaterThanOrEqual(3);
    }
  });

  it("白・黒の両端でも破綻しない", () => {
    expect(readableTextOn("#000000")).toBe("#FFFFFF");
    expect(readableTextOn("#FFFFFF")).toBe("#0B1220");
  });

  it("不正な値は白にフォールバックする", () => {
    expect(readableTextOn("")).toBe("#FFFFFF");
    expect(readableTextOn("rgb(1,2,3)")).toBe("#FFFFFF");
  });
});

describe("contrastRatio", () => {
  it("同じ色は 1、白と黒は 21", () => {
    expect(contrastRatio("#3b82f6", "#3b82f6")).toBeCloseTo(1, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
  });

  it("順序を入れ替えても同じ値になる", () => {
    expect(contrastRatio("#FFFFFF", "#3b82f6")).toBeCloseTo(contrastRatio("#3b82f6", "#FFFFFF"), 10);
  });
});
