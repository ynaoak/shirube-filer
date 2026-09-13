// ── デモモードのエントリポイント（demo.html から読み込み） ──────────
// アプリ本体のモジュール評価前に Tauri IPC モックを注入する必要がある
// （main.tsx はモジュール評価時に設定読み込み等の invoke を行うため）。
// そのため専用エントリでモックを先にインストールし、動的 import で本体を起動する。
import { installDemoMock } from "./mockTauri";

installDemoMock();
void import("../main");
