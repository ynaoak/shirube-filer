import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  acquireTerminal,
  disposeAllTerminals,
  disposeRemovedTerminals,
  disposeTerminal,
  registeredTerminalIds,
  releaseTerminal,
  type TerminalHandle,
} from "./terminalRegistry";

/** 差し込み先の付け外しと片付けを記録するだけの替え玉。 */
function fakeHandle() {
  const calls = { attach: 0, detach: 0, resize: 0, focus: 0, dispose: 0 };
  const handle: TerminalHandle = {
    attach: () => {
      calls.attach++;
    },
    detach: () => {
      calls.detach++;
    },
    resize: () => {
      calls.resize++;
    },
    focus: () => {
      calls.focus++;
    },
    dispose: () => {
      calls.dispose++;
    },
  };
  return { handle, calls };
}

describe("terminalRegistry", () => {
  beforeEach(() => disposeAllTerminals());

  it("同じ terminalId では実体を作り直さない", () => {
    const first = fakeHandle();
    const create = vi.fn(() => first.handle);

    const a = acquireTerminal("t1", create);
    const b = acquireTerminal("t1", create);

    // 2 度目は置き場のものを返す（作り直すと PTY が置き換わってプロセスが死ぬ）
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(registeredTerminalIds()).toEqual(["t1"]);
  });

  it("表示先から外しても実体は残る（ペインの組み替えで死なせない）", () => {
    const { handle, calls } = fakeHandle();
    acquireTerminal("t1", () => handle);

    releaseTerminal("t1");

    expect(calls.detach).toBe(1);
    expect(calls.dispose).toBe(0);
    expect(registeredTerminalIds()).toEqual(["t1"]);

    // 借り直すと同じ実体が返る
    const again = acquireTerminal("t1", () => fakeHandle().handle);
    expect(again).toBe(handle);
  });

  it("片付けたら置き場から消える", () => {
    const { handle, calls } = fakeHandle();
    acquireTerminal("t1", () => handle);

    disposeTerminal("t1");

    expect(calls.dispose).toBe(1);
    expect(registeredTerminalIds()).toEqual([]);
    // 二重に片付けても何も起きない
    disposeTerminal("t1");
    expect(calls.dispose).toBe(1);
  });

  it("知らない id の release / dispose は無視する", () => {
    expect(() => releaseTerminal("zzz")).not.toThrow();
    expect(() => disposeTerminal("zzz")).not.toThrow();
  });

  describe("disposeRemovedTerminals", () => {
    it("レイアウトから消えたものだけを片付ける", () => {
      const gone = fakeHandle();
      const kept = fakeHandle();
      acquireTerminal("gone", () => gone.handle);
      acquireTerminal("kept", () => kept.handle);

      const removed = disposeRemovedTerminals(["gone", "kept"], new Set(["kept"]));

      expect(removed).toEqual(["gone"]);
      expect(gone.calls.dispose).toBe(1);
      expect(kept.calls.dispose).toBe(0);
      expect(registeredTerminalIds()).toEqual(["kept"]);
    });

    it("レイアウトに属さないシェル（タスクパネル）には手を出さない", () => {
      const panel = fakeHandle();
      acquireTerminal("panel-shell", () => panel.handle);

      // known はレイアウトにあった id だけ。パネルのシェルは含まれない
      const removed = disposeRemovedTerminals([], new Set());

      expect(removed).toEqual([]);
      expect(panel.calls.dispose).toBe(0);
      expect(registeredTerminalIds()).toEqual(["panel-shell"]);
    });

    it("何も消えていなければ何もしない", () => {
      const { handle, calls } = fakeHandle();
      acquireTerminal("t1", () => handle);
      expect(disposeRemovedTerminals(["t1"], new Set(["t1"]))).toEqual([]);
      expect(calls.dispose).toBe(0);
    });
  });
});
