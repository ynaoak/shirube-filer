/**
 * ブラウザ上で Tauri アプリのフロントを動かすための最小モック。
 *
 * Playwright の addInitScript でページ読み込み前に実行し、`window.__TAURI_INTERNALS__`
 * を差し込むことで `@tauri-apps/api` の invoke / event / window を成立させる。
 * 起動時に呼ばれるコマンドへ安全な既定値を返し、アプリが（実バックエンド無しで）
 * 破綻なく描画されるようにする。未知コマンドは配列/ null を返してクラッシュを防ぐ。
 *
 * この関数は addInitScript にシリアライズして渡すため、外部参照を持たないこと。
 */
export function installTauriMock(): void {
  const w = window as unknown as Record<string, unknown>;

  // 起動時に参照される主なコマンドの既定返却値（形は実装の型に合わせる）
  const responses: Record<string, unknown> = {
    get_platform: "linux",
    get_os_accent_color: null,
    get_home_dir: "/home/user",
    get_parent_dir: "/home",
    // ReadDirResult = { path, entries: [] }
    read_dir: { path: "/home/user", entries: [] },
    load_ui_settings: "", // 空文字 → 既定設定
    load_tags: null,
    load_rules: [],
    load_sync_jobs: [],
    load_bookmarks: [],
    load_favorites: [],
    load_keybindings: [],
    load_context_menu_config: [],
    list_volumes: [],
    list_templates: [],
    list_shells: [],
    secret_get: null,
    path_exists: false,
    paths_exist: [],
    get_ui_settings_path: "/home/user/.config/shirube-filer/settings.json",
  };

  let cbId = 0;

  // モックであることの目印。ネイティブのファイルドラッグ（tauri-plugin-drag）は
  // Playwright の合成 D&D では再現できないため、nativeFileDrag はこれを見て
  // HTML5 のドラッグ経路に留まる。実アプリではこのフラグは存在しない。
  w.__TAURI_E2E_MOCK__ = true;

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback(_cb: unknown, _once?: boolean) {
      cbId += 1;
      return cbId;
    },
    convertFileSrc(path: string) {
      return path;
    },
    async invoke(cmd: string) {
      // 保存レイアウト無し → アプリは既定レイアウトを使う（.catch される）
      if (cmd === "load_layout") throw new Error("e2e mock: no saved layout");
      // window プラグイン
      if (cmd === "plugin:window|is_focused") return true;
      if (cmd.indexOf("plugin:event|") === 0) return 0; // listen/unlisten 用 ID
      if (cmd.indexOf("plugin:") === 0) return null;
      // 既知コマンド
      if (Object.prototype.hasOwnProperty.call(responses, cmd)) return responses[cmd];
      // 既定: 一覧系は空配列（.map クラッシュ回避）、それ以外は null
      if (/^(load_|list_|read_|get_)/.test(cmd)) return [];
      return null;
    },
  };

  // 一部 API が参照する保険
  w.__TAURI__ = (w.__TAURI__ as unknown) ?? {};
}
