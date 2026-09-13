/**
 * e2e から addInitScript で注入するコードが触るブラウザ側のグローバル。
 *
 * spec 本体（Node 側）と注入コード（ブラウザ側）は同じファイルに書くため、
 * Tauri の IPC ブリッジをここで型として宣言しておく。実体は
 * `installTauriMock`（support/tauri-mock.ts）が差し込む。
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: unknown) => Promise<unknown>;
      [key: string]: unknown;
    };
    /** モックの目印。nativeFileDrag はこれを見て HTML5 ドラッグ経路に留まる。 */
    __TAURI_E2E_MOCK__?: boolean;
  }
}

export {};
