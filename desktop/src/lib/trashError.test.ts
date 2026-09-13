import { describe, it, expect } from "vitest";
import { TRASH_UNAVAILABLE, isTrashUnavailable, stripTrashMarker } from "./trashError";

// Rust 側（windows_trash.rs の TrashError::Unavailable）が返す形。
const UNAVAILABLE = `${TRASH_UNAVAILABLE} ゴミ箱に移動できません: ゴミ箱の容量を超えています`;
// ゴミ箱に入れられない以外の失敗（TrashError::Failed）。
const FAILED = "ゴミ箱に移動できません: C:\\work\\a.txt を他のプログラムが使用中です";

describe("trashError", () => {
  it("目印つきのエラーだけをゴミ箱不可と判定する", () => {
    expect(isTrashUnavailable(UNAVAILABLE)).toBe(true);
    expect(isTrashUnavailable(FAILED)).toBe(false);
  });

  it("表示用に目印を取り除く", () => {
    expect(stripTrashMarker(UNAVAILABLE)).toBe("ゴミ箱に移動できません: ゴミ箱の容量を超えています");
  });

  it("目印が無いメッセージは変えない", () => {
    expect(stripTrashMarker(FAILED)).toBe(FAILED);
  });
});
