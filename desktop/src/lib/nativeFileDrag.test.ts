import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  INTERNAL_DRAG_TYPE,
  beginNativeFileDrag,
  canStartNativeDrag,
  clearActiveDrag,
  internalDropEffect,
  isInternalDrag,
  readInternalDrag,
  setActiveDrag,
} from "./nativeFileDrag";

/** DataTransfer の必要なところだけを模した最小の代役。 */
function fakeDataTransfer(entries: Record<string, string> = {}): DataTransfer {
  return {
    types: Object.keys(entries),
    getData: (type: string) => entries[type] ?? "",
  } as unknown as DataTransfer;
}

const payload = {
  srcPath: "/home/user/a.txt",
  srcPaths: ["/home/user/a.txt", "/home/user/b.txt"],
  srcPaneId: "pane-1",
};

describe("canStartNativeDrag", () => {
  beforeEach(() => {
    // Tauri の中にいる体にする（ブラウザのデモでは使えない）。
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  it("accepts absolute POSIX and Windows paths", () => {
    expect(canStartNativeDrag(["/home/user/a.txt"])).toBe(true);
    expect(canStartNativeDrag(["C:\\Users\\me\\a.txt"])).toBe(true);
    expect(canStartNativeDrag(["C:/Users/me/a.txt"])).toBe(true);
    expect(canStartNativeDrag(["\\\\nas\\share\\a.txt"])).toBe(true);
  });

  it("refuses virtual paths that the OS cannot open", () => {
    // MTP 端末の中身は OS から見えるファイルではないので渡せない。
    expect(canStartNativeDrag(["mtp://Apple iPhone/Internal Storage/a.mp4"])).toBe(false);
    // 1つでも渡せないものが混ざっていたら、そのドラッグごと諦める
    // （一部だけ運ばれるほうが分かりにくい）。
    expect(canStartNativeDrag(["/home/user/a.txt", "mtp://x/y"])).toBe(false);
  });

  it("refuses an empty selection", () => {
    expect(canStartNativeDrag([])).toBe(false);
  });

  it("refuses outside Tauri (browser demo)", () => {
    delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(canStartNativeDrag(["/home/user/a.txt"])).toBe(false);
  });

  it("refuses under the e2e mock (Playwright cannot drive an OS drag)", () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_E2E_MOCK__ = true;
    try {
      expect(canStartNativeDrag(["/home/user/a.txt"])).toBe(false);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).__TAURI_E2E_MOCK__;
    }
  });
});

describe("beginNativeFileDrag", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  let invoked: Array<{ cmd: string; args: Record<string, unknown> }>;

  beforeEach(() => {
    invoked = [];
    g.window = globalThis;
    // Channel と invoke が使う最小限の __TAURI_INTERNALS__。
    g.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        invoked.push({ cmd, args });
        return null;
      },
    };
    // node 環境には document が無い。ドラッグ画像は canvas が無ければ
    // 空文字 → 1x1 PNG フォールバックに落ちる、という経路を通す。
    g.document = { createElement: () => ({ getContext: () => null }) };
  });
  afterEach(() => {
    clearActiveDrag();
    delete g.__TAURI_INTERNALS__;
    delete g.document;
    delete g.window;
  });

  it("cancels the HTML5 drag, stashes the payload and starts the OS drag", async () => {
    const preventDefault = vi.fn();
    expect(beginNativeFileDrag({ preventDefault }, payload, "a.txt")).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    // OS ドラッグ中は dataTransfer が読めないので、控えから読めること。
    expect(readInternalDrag(fakeDataTransfer())).toEqual(payload);

    await new Promise((r) => setTimeout(r, 0));
    expect(invoked).toHaveLength(1);
    expect(invoked[0].cmd).toBe("plugin:drag|start_drag");
    expect(invoked[0].args.item).toEqual(payload.srcPaths);
    // canvas が使えない環境でもプラグインが要求する PNG を必ず渡す。
    expect(invoked[0].args.image).toMatch(/^data:image\/png;base64,/);
  });

  it("leaves the HTML5 drag alone when the native drag is unavailable", () => {
    delete g.__TAURI_INTERNALS__;
    const preventDefault = vi.fn();
    expect(beginNativeFileDrag({ preventDefault }, payload, "a.txt")).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(readInternalDrag(fakeDataTransfer())).toBeNull();
  });

  it("leaves the HTML5 drag alone under the e2e mock", () => {
    g.__TAURI_E2E_MOCK__ = true;
    try {
      const preventDefault = vi.fn();
      expect(beginNativeFileDrag({ preventDefault }, payload, "a.txt")).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
    } finally {
      delete g.__TAURI_E2E_MOCK__;
    }
  });
});

describe("internalDropEffect", () => {
  it("moves for an HTML5 drag that carries our MIME type", () => {
    expect(internalDropEffect(fakeDataTransfer({ [INTERNAL_DRAG_TYPE]: "{}" }))).toBe("move");
  });

  it("copies for a native drag (copy is all the OS drag allows)", () => {
    // "move" を返すと drag operation が none になり drop 自体が発火しない。
    expect(internalDropEffect(fakeDataTransfer({ Files: "" }))).toBe("copy");
  });
});

describe("readInternalDrag", () => {
  afterEach(() => clearActiveDrag());

  it("reads the payload out of the DataTransfer", () => {
    const dt = fakeDataTransfer({ [INTERNAL_DRAG_TYPE]: JSON.stringify(payload) });
    expect(readInternalDrag(dt)).toEqual(payload);
  });

  it("falls back to the stashed drag when the DataTransfer is empty", () => {
    // OS のドラッグへ引き継いだあとは dataTransfer から読めなくなる。
    setActiveDrag(payload);
    expect(readInternalDrag(fakeDataTransfer())).toEqual(payload);
  });

  it("returns null when nothing is being dragged", () => {
    expect(readInternalDrag(fakeDataTransfer())).toBeNull();
  });

  it("ignores malformed JSON and falls back", () => {
    setActiveDrag(payload);
    const dt = fakeDataTransfer({ [INTERNAL_DRAG_TYPE]: "{not json" });
    expect(readInternalDrag(dt)).toEqual(payload);
  });

  it("accepts a payload that only carries srcPath", () => {
    const dt = fakeDataTransfer({
      [INTERNAL_DRAG_TYPE]: JSON.stringify({ srcPath: "/x/a.txt", srcPaneId: "p" }),
    });
    expect(readInternalDrag(dt)).toEqual({
      srcPath: "/x/a.txt",
      srcPaths: ["/x/a.txt"],
      srcPaneId: "p",
    });
  });
});

describe("stale drag payloads", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearActiveDrag();
  });

  it("stops claiming a drag that never got its completion event", () => {
    // 控えの解除はプラグインの終了イベント頼みなので、取りこぼすと残り続ける。
    // 残ったままだと、他アプリから来たドロップを内部ドラッグと誤認し、
    // 「落とした物ではなく前に掴んでいた物」を動かしてしまう。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    setActiveDrag(payload);
    expect(isInternalDrag(fakeDataTransfer({ Files: "" }))).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:01:00Z")); // 1 分後
    expect(isInternalDrag(fakeDataTransfer({ Files: "" }))).toBe(false);
    expect(readInternalDrag(fakeDataTransfer())).toBeNull();
  });

  it("keeps the payload for the duration of a normal drag", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    setActiveDrag(payload);
    vi.setSystemTime(new Date("2026-01-01T00:00:05Z")); // 5 秒後
    expect(readInternalDrag(fakeDataTransfer())).toEqual(payload);
  });
});

describe("isInternalDrag", () => {
  afterEach(() => clearActiveDrag());

  it("recognises our own MIME type", () => {
    expect(isInternalDrag(fakeDataTransfer({ [INTERNAL_DRAG_TYPE]: "{}" }))).toBe(true);
  });

  it("recognises a drag we started even without the MIME type", () => {
    setActiveDrag(payload);
    expect(isInternalDrag(fakeDataTransfer({ Files: "" }))).toBe(true);
  });

  it("does not claim files dragged in from another app", () => {
    // 外から来たドラッグには手を出さない（こちらは何も掴んでいない）。
    expect(isInternalDrag(fakeDataTransfer({ Files: "" }))).toBe(false);
  });

  it("stops claiming once the drag is over", () => {
    setActiveDrag(payload);
    clearActiveDrag();
    expect(isInternalDrag(fakeDataTransfer({ Files: "" }))).toBe(false);
  });
});
