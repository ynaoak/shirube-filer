import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  INTERRUPT,
  dropTerminalCommand,
  interruptTerminal,
  queueTerminalCommand,
  sendTerminalCommand,
  takeTerminalCommand,
  typeTerminalCommand,
} from "./terminalCommand";

describe("預かったコマンド", () => {
  beforeEach(() => invoke.mockClear());
  afterEach(() => {
    for (const id of ["t1", "t2"]) dropTerminalCommand(id);
  });

  it("預けたターミナルが 1 回だけ取り出せる", () => {
    queueTerminalCommand("t1", "pnpm run dev");
    expect(takeTerminalCommand("t1")).toEqual({ command: "pnpm run dev", submit: true });
    // 2 回目は無い（再マウントで二重に実行されないこと）
    expect(takeTerminalCommand("t1")).toBeNull();
  });

  it("実行しない預かりは submit=false で渡る", () => {
    queueTerminalCommand("t1", "cargo run", false);
    expect(takeTerminalCommand("t1")).toEqual({ command: "cargo run", submit: false });
  });

  it("預けていないターミナルには何も渡さない", () => {
    expect(takeTerminalCommand("t2")).toBeNull();
  });

  it("開かれずに終わった預かりが溜まり続けない", () => {
    for (let i = 0; i < 20; i++) queueTerminalCommand(`stale-${i}`, "cargo build");
    // 古いものから溢れる。最後に預けたものは必ず残る
    expect(takeTerminalCommand("stale-19")).toEqual({ command: "cargo build", submit: true });
    expect(takeTerminalCommand("stale-0")).toBeNull();
  });
});

describe("ターミナルへの送信", () => {
  beforeEach(() => invoke.mockClear());

  it("コマンドの末尾に CR を付けて実行させる", async () => {
    await sendTerminalCommand("t1", "cargo run");
    expect(invoke).toHaveBeenCalledWith("pty_write", {
      terminalId: "t1",
      data: "cargo run\r",
    });
  });

  it("停止は Ctrl+C を送る", async () => {
    await interruptTerminal("t1");
    expect(invoke).toHaveBeenCalledWith("pty_write", { terminalId: "t1", data: INTERRUPT });
  });

  it("実行しない入力は CR を付けない（引数を足してから実行できる）", async () => {
    await typeTerminalCommand("t1", "cargo run");
    expect(invoke).toHaveBeenCalledWith("pty_write", {
      terminalId: "t1",
      data: "cargo run",
    });
  });
});
