import { describe, expect, it, vi } from "vitest";
import { confirmConnectionRemoval } from "./confirmConnectionRemoval";

describe("confirmConnectionRemoval", () => {
  it("確認ポップアップでキャンセルした場合は接続を削除しない", () => {
    const remove = vi.fn();
    const confirmRemoval = vi.fn(() => false);

    confirmConnectionRemoval("接続を削除しますか？", remove, confirmRemoval);

    expect(confirmRemoval).toHaveBeenCalledWith("接続を削除しますか？");
    expect(remove).not.toHaveBeenCalled();
  });

  it("確認ポップアップで決定した場合だけ接続を削除する", () => {
    const remove = vi.fn();
    const confirmRemoval = vi.fn(() => true);

    confirmConnectionRemoval("接続を削除しますか？", remove, confirmRemoval);

    expect(confirmRemoval).toHaveBeenCalledWith("接続を削除しますか？");
    expect(remove).toHaveBeenCalledOnce();
  });
});
