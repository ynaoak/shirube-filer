import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  DEFAULT_PORT,
  MAX_PORT,
  MIN_PORT,
  newPresetId,
  parsePort,
  presetLabel,
  removePreset,
  startStaticServer,
  stopStaticServer,
  upsertPreset,
} from "./staticServer";

describe("parsePort", () => {
  it("使えるポートはそのまま数値にする", () => {
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort(" 3000 ")).toBe(3000);
    expect(parsePort(String(MIN_PORT))).toBe(MIN_PORT);
    expect(parsePort(String(MAX_PORT))).toBe(MAX_PORT);
    expect(parsePort(String(DEFAULT_PORT))).toBe(DEFAULT_PORT);
  });

  it("特権ポートと範囲外を弾く", () => {
    for (const bad of ["0", "80", "443", "1023", "65536", "-1"]) {
      expect(parsePort(bad), bad).toBeNull();
    }
  });

  it("数字以外が混じった入力を別のポートと読み替えない", () => {
    // "80 80" を 80 や 8080 と読んでしまうと、意図しないポートを開いてしまう
    for (const bad of ["", "  ", "80 80", "8080abc", "8e3", "8080.5", "０８０８０"]) {
      expect(parsePort(bad), bad).toBeNull();
    }
  });
});

describe("呼び出し", () => {
  beforeEach(() => invoke.mockClear());

  it("ルートとポートをそのまま渡し、ホットリロードは既定で有効", async () => {
    await startStaticServer("/home/u/site", 8080);
    expect(invoke).toHaveBeenCalledWith("start_static_server", {
      root: "/home/u/site",
      port: 8080,
      liveReload: true,
    });
  });

  it("ホットリロードを切った登録はそのまま伝える", async () => {
    await startStaticServer("/home/u/site", 8080, false);
    expect(invoke).toHaveBeenCalledWith("start_static_server", {
      root: "/home/u/site",
      port: 8080,
      liveReload: false,
    });
  });

  it("停止はポートだけで指定する", async () => {
    await stopStaticServer(8080);
    expect(invoke).toHaveBeenCalledWith("stop_static_server", { port: 8080 });
  });
});

describe("登録の出し入れ", () => {
  const site = { id: "a", label: "", root: "/home/u/site", port: 8080, liveReload: true };
  const docs = {
    id: "b",
    label: "ドキュメント",
    root: "/home/u/docs",
    port: 8081,
    liveReload: false,
  };

  it("新しい登録は末尾に足す", () => {
    expect(upsertPreset([site], docs)).toEqual([site, docs]);
  });

  it("同じフォルダ・同じポートの登録は増やさず差し替える", () => {
    const again = { ...site, id: "c", label: "サイト" };
    const list = upsertPreset([site, docs], again);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(again);
    expect(list[1]).toEqual(docs);
  });

  it("末尾の区切りや区切り文字の違いも同じ登録として扱う", () => {
    const again = { ...site, id: "c", root: "/home/u/site/" };
    expect(upsertPreset([site], again)).toHaveLength(1);
  });

  it("同じフォルダでもポートが違えば別の登録", () => {
    const otherPort = { ...site, id: "c", port: 8888 };
    expect(upsertPreset([site], otherPort)).toHaveLength(2);
  });

  it("id が同じなら中身を入れ替える（編集）", () => {
    const edited = { ...site, root: "/home/u/moved", port: 9000 };
    expect(upsertPreset([site, docs], edited)).toEqual([edited, docs]);
  });

  it("削除は id で当てる", () => {
    expect(removePreset([site, docs], "a")).toEqual([docs]);
    expect(removePreset([site, docs], "zzz")).toEqual([site, docs]);
  });

  it("表示名が未設定ならフォルダ名を出す", () => {
    expect(presetLabel(site)).toBe("site");
    expect(presetLabel(docs)).toBe("ドキュメント");
    expect(presetLabel({ ...site, label: "  " })).toBe("site");
    expect(presetLabel({ ...site, root: "C:\\dev\\app\\" })).toBe("app");
  });

  it("id は登録ごとに違う値になる", () => {
    expect(newPresetId()).not.toBe(newPresetId());
  });
});
