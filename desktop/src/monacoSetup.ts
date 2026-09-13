/**
 * Monaco Editor worker environment setup.
 * Must be imported before any Monaco or @monaco-editor/react import.
 *
 * typescript/css/html の言語サービス用ワーカー（合計 ~8.4MB）は同梱しない:
 *  - ファイラーの組み込みエディタに必要なのはシンタックスハイライト
 *    （monarch トークナイザ）で、これはメインスレッド側で動きワーカー不要。
 *  - 失うのはエディタ内の入力補完・型診断のみ（本格編集は関連付けアプリで）。
 * JSON のみ contribution を読み込むため専用ワーカーを返す（小型）。
 */
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment: {
      getWorker: (_: string, label: string) => Worker;
    };
  }
}

window.MonacoEnvironment = {
  getWorker(_: string, label: string): Worker {
    if (label === "json") return new jsonWorker();
    return new editorWorker();
  },
};
