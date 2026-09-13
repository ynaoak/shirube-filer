/**
 * ターミナル（PTY）へコマンドを流し込むための受け渡し。
 *
 * 新しく開いたターミナルは Terminal コンポーネントがマウントされてから PTY を作るため、
 * 開く側はここにコマンドを預けておき、Terminal が起動直後に取り出して送る。
 * 預けたコマンドはレイアウトには保存しない（保存するとアプリを開き直すたびに
 * 勝手に走ってしまうため）。
 */

import { invoke } from "@tauri-apps/api/core";

/** Ctrl+C。開発サーバーなど動かしっぱなしのタスクを止めるのに使う。 */
export const INTERRUPT = "\x03";

/** 起動直後のシェルに渡すもの。`submit` が false なら Enter を押さずに置くだけ。 */
export type PendingCommand = {
  command: string;
  submit: boolean;
};

const pending = new Map<string, PendingCommand>();

/**
 * 預かりの上限。
 *
 * ターミナルが開かれずに終わると預かりは残り続ける（React の StrictMode では
 * マウントとアンマウントが往復するため、アンマウントで捨てるわけにいかない）。
 * 古いものから溢れさせて、取りこぼしが積み上がらないようにする。
 */
const MAX_PENDING = 8;

/**
 * ターミナル起動後に流すコマンドを預ける。
 *
 * `submit` を false にすると Enter を送らず入力欄に置くだけにする
 * （オプションを足してから自分で実行したいとき）。
 */
export function queueTerminalCommand(terminalId: string, command: string, submit = true) {
  pending.set(terminalId, { command, submit });
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
}

/** 預けられたコマンドを取り出す（1 回限り）。 */
export function takeTerminalCommand(terminalId: string): PendingCommand | null {
  const queued = pending.get(terminalId);
  if (queued === undefined) return null;
  pending.delete(terminalId);
  return queued;
}

/** 開かれずに終わったターミナル用の後始末。 */
export function dropTerminalCommand(terminalId: string) {
  pending.delete(terminalId);
}

/**
 * 実行中のターミナルへコマンドを送る。
 *
 * 末尾は改行ではなく CR。端末のエンターキーが送るのは CR で、xterm.js も同じものを
 * 送っている（LF だとシェルによっては行が確定しない）。
 */
export function sendTerminalCommand(terminalId: string, command: string): Promise<void> {
  return invoke("pty_write", { terminalId, data: `${command}\r` });
}

/**
 * コマンドを実行せずシェルの入力欄に置く。
 *
 * `cargo run` に引数を足すなど、押す前に手を入れたいときのための導線。
 */
export function typeTerminalCommand(terminalId: string, command: string): Promise<void> {
  return invoke("pty_write", { terminalId, data: command });
}

/** 実行中のプロセスへ Ctrl+C を送る。 */
export function interruptTerminal(terminalId: string): Promise<void> {
  return invoke("pty_write", { terminalId, data: INTERRUPT });
}
