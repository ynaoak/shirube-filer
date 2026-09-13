/**
 * 起動したままにするタスク（開発サーバー・ウォッチ）の実行状態。
 *
 * パネルを閉じても状態を保ちたいので、React の外にモジュール単位で持つ。
 * プロセスの生死をアプリ側から知る術は無いため、「どのターミナルで走らせたか」を
 * 覚えておき、そのターミナルが閉じられたら実行中から外す（prune）。
 */

import { useSyncExternalStore } from "react";

export type RunningTask = {
  /** projectTasks.taskKey() の値 */
  key: string;
  terminalId: string;
  label: string;
  command: string;
  startedAt: number;
};

let running: RunningTask[] = [];
const listeners = new Set<() => void>();

function setRunning(next: RunningTask[]) {
  running = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 実行開始を記録する（同じタスクの再起動は上書き）。 */
export function markTaskStarted(task: RunningTask) {
  setRunning([...running.filter((t) => t.key !== task.key), task]);
}

/** 実行中から外す。 */
export function markTaskStopped(key: string) {
  if (!running.some((t) => t.key === key)) return;
  setRunning(running.filter((t) => t.key !== key));
}

/**
 * 生きているターミナルに紐づかない実行中タスクを落とす。
 *
 * 変化が無ければ同じ配列を保つ（呼び出し元が effect で回しても再描画が続かないように）。
 */
export function pruneRunningTasks(aliveTerminalIds: Set<string>) {
  const next = running.filter((t) => aliveTerminalIds.has(t.terminalId));
  if (next.length === running.length) return;
  setRunning(next);
}

export function getRunningTasks(): RunningTask[] {
  return running;
}

export function useRunningTasks(): RunningTask[] {
  return useSyncExternalStore(subscribe, getRunningTasks, getRunningTasks);
}

/** テスト用リセット。 */
export function resetRunningTasks() {
  setRunning([]);
}
