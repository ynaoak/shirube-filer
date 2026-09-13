// ── デモモード用 Tauri IPC モック ─────────────────────────────────────
// Tauri を起動せずにブラウザだけで UI を表示するため、
// `window.__TAURI_INTERNALS__` をサンプルデータで応答する実装に差し替える。
// アプリ本体（src/main.tsx 以下）のコードには一切手を入れない。
//
// 方針:
//   - 画面表示に必要なコマンドはサンプルデータで具体的に応答
//   - 破壊系（move/copy/delete 等）は成功したふりをする（表示は変わらない）
//   - それ以外の load_/list_/get_ 系は空配列、plugin: 系は無害な既定値
import {
  buildFs,
  HOME_DIR,
  VOLUMES,
  SYNC_JOBS,
  SYNC_HISTORY,
  GIT_STATUS,
  GIT_LOG,
  GIT_STASHES,
  GIT_DIFF,
  TEXT_CONTENTS,
  PROJECT_TASKS,
  SERVER_PRESETS,
  STATIC_SERVERS,
  SHELL_PROMPT,
  SHELL_OUTPUTS,
} from "./sampleData";

export function installDemoMock(): void {
  const w = window as unknown as Record<string, unknown>;
  const fs = buildFs();
  let cbId = 0;

  // Tauri イベントの模擬: transformCallback で登録されたコールバックを保持し、
  // plugin:event|listen でイベント名 → コールバック id を対応付ける。
  // window.__demoEmit("copy-progress", payload) で任意のイベントを発火でき、
  // 進捗 UI などイベント駆動の画面をブラウザだけで確認できる。
  const callbacks = new Map<number, (e: unknown) => void>();
  const listeners = new Map<string, Set<number>>();
  w.__demoEmit = (event: string, payload: unknown) => {
    for (const id of listeners.get(event) ?? []) {
      callbacks.get(id)?.({ event, id, payload });
    }
  };

  const parentOf = (p: string): string | null => {
    if (!p || p === "/") return null;
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  };

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback(cb?: (e: unknown) => void) {
      cbId += 1;
      if (cb) callbacks.set(cbId, cb);
      return cbId;
    },
    convertFileSrc(path: string) {
      return path;
    },
    async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      switch (cmd) {
        // ── ファイルシステム ────────────────────────────────────────
        case "read_dir": {
          const path = (args?.path as string) || "/";
          return { path, entries: fs.get(path) ?? [] };
        }
        case "list_volumes":
          return VOLUMES;
        case "mtp_list_devices":
          // デモ用: スマホ接続時のドライブ一覧表示を確認できるよう 1 台返す
          return [{ name: "iPhone" }];
        case "get_home_dir":
          return HOME_DIR;
        case "get_parent_dir":
          return parentOf((args?.path as string) ?? "");
        case "path_exists": {
          // 仮想 FS に存在するパスだけ true（ホームのクイックアクセス表示などに使用）
          const q = args?.path as string;
          if (!q) return false;
          if (fs.has(q)) return true;
          const parent = parentOf(q);
          return parent !== null && (fs.get(parent) ?? []).some((e) => e.path === q);
        }
        case "paths_exist": {
          const list = (args?.paths as string[]) ?? [];
          return list.map((q) => {
            if (!q) return false;
            if (fs.has(q)) return true;
            const parent = parentOf(q);
            return parent !== null && (fs.get(parent) ?? []).some((e) => e.path === q);
          });
        }
        case "unique_dest_path": {
          // デモでは実ファイルを作らないので "(2)" を付けた名前を返すだけ
          const p = (args?.path as string) ?? "";
          const name = p.split(/[\\/]/).pop() ?? "";
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          return p.slice(0, p.length - name.length) + `${base} (2)${ext}`;
        }
        case "watch_dir":
        case "unwatch_dir":
        case "cancel_scan":
          return null;
        case "get_os_accent_color":
          // デモ用: localStorage("demo-os-accent") で任意の OS アクセント色を再現できる
          return localStorage.getItem("demo-os-accent");

        // ── レイアウト・設定 ────────────────────────────────────────
        case "load_layout": {
          // 撮影スクリプトが localStorage("demo-layout") に置いた JSON を
          // 保存済みレイアウトとして返す（ペイン分割や開くパスを固定できる）
          const saved = localStorage.getItem("demo-layout");
          if (saved) return saved;
          throw new Error("demo: 保存済みレイアウトなし（既定レイアウトを使用）");
        }
        case "load_ui_settings":
          throw new Error("demo: 保存済み設定なし（既定値を使用）");

        // ── クラウド同期 ────────────────────────────────────────────
        case "load_sync_jobs":
          return SYNC_JOBS;
        case "secret_get":
          // refreshToken を返すと接続済み表示になる（見栄え用）
          return String(args?.account ?? "").includes("refreshToken") ? "demo-refresh-token" : null;
        case "load_sync_history": {
          const offset = (args?.offset as number) ?? 0;
          const errorsOnly = args?.errorsOnly === true;
          const all = errorsOnly ? SYNC_HISTORY.filter((e) => e.status === "error") : SYNC_HISTORY;
          return { total: all.length, entries: all.slice(offset, offset + ((args?.limit as number) ?? 100)) };
        }

        // ── プレビュー（テキストのサンプル本文） ─────────────────────
        case "read_text_file": {
          const path = args?.path as string;
          return TEXT_CONTENTS[path] ?? "（デモ: このファイルのサンプル本文はありません）";
        }
        case "get_file_metadata": {
          const path = (args?.path as string) ?? "";
          const parent = parentOf(path);
          const entry = parent ? (fs.get(parent) ?? []).find((e) => e.path === path) : undefined;
          return { size: entry?.size ?? 0 };
        }

        // ── Git（Git パネルのデモ表示用） ────────────────────────────
        case "git_repo_status":
          return GIT_STATUS;
        case "git_log":
          return GIT_LOG;
        case "git_stash_list":
          return GIT_STASHES;
        case "git_diff":
          return GIT_DIFF;

        // ── プロジェクトタスク / 組み込みサーバー ───────────────────
        case "detect_project_tasks": {
          const dir = ((args?.dir as string) ?? "").replace(/\/+$/, "");
          const project = PROJECT_TASKS.find((p) => dir === p.dir || dir.startsWith(p.dir + "/"));
          if (!project) return { dir, fromAncestor: false, isDir: fs.has(dir), manifests: [] };
          return { dir: project.dir, fromAncestor: dir !== project.dir, isDir: true, manifests: project.manifests };
        }
        case "load_server_presets":
          return SERVER_PRESETS;
        case "list_static_servers":
          return STATIC_SERVERS;
        case "start_static_server": {
          const port = (args?.port as number) ?? 8080;
          return { port, root: args?.root, url: `http://127.0.0.1:${port}/`, liveReload: args?.liveReload !== false };
        }
        case "save_server_presets":
        case "stop_static_server":
          return null;

        // ── 擬似 PTY（パネル内シェル・ターミナルタブ用） ─────────────
        // 実プロセスは無いので、プロンプトを出し、書き込みをエコーし、
        // 既知のコマンドにはそれらしい出力を返す。
        case "pty_create": {
          const terminalId = args?.terminalId as string;
          setTimeout(() => (w.__demoEmit as (e: string, p: unknown) => void)("pty-output", { terminalId, data: SHELL_PROMPT }), 50);
          return null;
        }
        case "pty_write": {
          const terminalId = args?.terminalId as string;
          const data = (args?.data as string) ?? "";
          const emit = w.__demoEmit as (e: string, p: unknown) => void;
          const line = data.replace(/[\r\n]+$/, "");
          if (/[\r\n]$/.test(data)) {
            const out = SHELL_OUTPUTS[line.trim()];
            emit("pty-output", { terminalId, data: line + "\r\n" + (out ?? "") });
            // 常駐コマンド（dev サーバー等）は出力を出したまま止まっているように見せる
            if (out === undefined || !/dev/.test(line)) {
              setTimeout(() => emit("pty-output", { terminalId, data: SHELL_PROMPT }), 30);
            }
          } else if (data === "\x03") {
            emit("pty-output", { terminalId, data: "^C\r\n" + SHELL_PROMPT });
          } else {
            emit("pty-output", { terminalId, data });
          }
          return null;
        }
        case "pty_resize":
        case "pty_kill":
          return null;

        // ── クリップボード / 破壊系（成功したふり） ──────────────────
        case "clipboard_get_file_list":
          return null;
        case "move_item":
        case "copy_item":
        case "delete_item":
        case "clipboard_set_file_list":
        case "clipboard_clear_file_list":
        case "save_sync_jobs":
        case "append_sync_history":
        case "secret_set":
        case "secret_delete":
          return null;

        default:
          break;
      }

      // Tauri プラグイン API（window / event / os など）
      if (cmd === "plugin:window|get_all_windows") return [];
      if (cmd === "plugin:window|is_focused") return true;
      if (cmd === "plugin:window|is_maximized") return false;
      if (cmd === "plugin:event|listen") {
        const event = args?.event as string;
        const handler = args?.handler as number;
        if (event && typeof handler === "number") {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(handler);
        }
        return handler ?? 0;
      }
      if (cmd === "plugin:event|unlisten") {
        const eventName = args?.event as string;
        const id = args?.eventId as number;
        listeners.get(eventName)?.delete(id);
        return null;
      }
      if (cmd.startsWith("plugin:event|")) return 0;
      if (cmd.startsWith("plugin:")) return null;

      // 未知の取得系は空、その他は null（デモでは十分）
      if (/^(load_|list_|read_|get_|search_|find_)/.test(cmd)) return [];
      return null;
    },
  };
  w.__TAURI__ = w.__TAURI__ ?? {};
  // @tauri-apps/api/event の unlisten が参照する内部 API（無いと解除時に例外）
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {
      /* demo: no-op */
    },
  };
}
