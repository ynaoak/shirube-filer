import { describe, it, expect, beforeEach } from "vitest";
import {
  getRunningTasks,
  markTaskStarted,
  markTaskStopped,
  pruneRunningTasks,
  resetRunningTasks,
} from "./taskRunnerStore";

const task = (key: string, terminalId: string) => ({
  key,
  terminalId,
  label: key,
  command: `pnpm run ${key}`,
  startedAt: 1,
});

describe("taskRunnerStore", () => {
  beforeEach(() => resetRunningTasks());

  it("同じタスクを再起動しても二重に並ばない", () => {
    markTaskStarted(task("a", "pty-1"));
    markTaskStarted({ ...task("a", "pty-1"), startedAt: 2 });
    expect(getRunningTasks()).toHaveLength(1);
    expect(getRunningTasks()[0].startedAt).toBe(2);
  });

  it("停止で実行中から外れる", () => {
    markTaskStarted(task("a", "pty-1"));
    markTaskStarted(task("b", "pty-2"));
    markTaskStopped("a");
    expect(getRunningTasks().map((t) => t.key)).toEqual(["b"]);
  });

  it("ターミナルが閉じられたタスクを掃除する", () => {
    markTaskStarted(task("a", "pty-1"));
    markTaskStarted(task("b", "pty-2"));
    pruneRunningTasks(new Set(["pty-2"]));
    expect(getRunningTasks().map((t) => t.key)).toEqual(["b"]);
  });

  it("掃除で何も変わらないときは同じ配列を保つ（再描画を誘発しない）", () => {
    markTaskStarted(task("a", "pty-1"));
    const before = getRunningTasks();
    pruneRunningTasks(new Set(["pty-1"]));
    expect(getRunningTasks()).toBe(before);
  });
});
