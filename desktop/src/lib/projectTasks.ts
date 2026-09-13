/**
 * プロジェクトタスク（package.json のスクリプト / Cargo のビルド・実行 / Makefile の
 * ターゲット）をパネルで扱うための型と小物。
 *
 * 検出とコマンド行の組み立ては Rust 側（task_commands.rs）が行う。ここはその結果を
 * 受け取って表示・実行するための共通部分だけを持つ。
 */

export type TaskKind =
  | "build"
  | "run"
  | "stop"
  | "test"
  | "lint"
  | "format"
  | "check"
  | "clean"
  | "install"
  | "script";

export type ProjectTask = {
  id: string;
  label: string;
  detail: string | null;
  /** ターミナルへ書き込むコマンド行（Rust 側で引用符を付与済み） */
  command: string;
  kind: TaskKind;
  /** 開発サーバーのように起動したまま使うタスク */
  longRunning: boolean;
};

export type ProjectManifest = {
  /** "node" | "rust" | "make" | "docker" */
  kind: string;
  /** マニフェストの絶対パス */
  file: string;
  /** 実行に使うツール名（pnpm / cargo / make） */
  tool: string;
  name: string | null;
  tasks: ProjectTask[];
};

export type ProjectTasks = {
  dir: string;
  fromAncestor: boolean;
  /** 問い合わせたパスがローカルの実在フォルダだったか（クラウド・MTP では false） */
  isDir: boolean;
  manifests: ProjectManifest[];
};

/** 実行中タスクの照合に使う、マニフェスト横断で一意なキー。 */
export function taskKey(manifest: ProjectManifest, task: ProjectTask): string {
  return `${manifest.file}::${task.id}`;
}

/**
 * タスクを組み立てられるマニフェストのファイル名。
 *
 * 検出する側（src-tauri/src/task_commands.rs の detect_in_dir）と対応させる。
 * 追加するときは両方を直すこと。
 */
export const PROJECT_MANIFEST_FILES = [
  "package.json",
  "Cargo.toml",
  "Makefile",
  "makefile",
  "GNUmakefile",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  "Dockerfile",
] as const;

const MANIFEST_NAMES_LOWER = new Set(
  PROJECT_MANIFEST_FILES.map((name) => name.toLowerCase())
);

/**
 * そのファイルがプロジェクトタスクの出どころか。
 *
 * 大文字小文字は無視する（Windows では `cargo.toml` も同じファイル）。取りこぼすと
 * パネルが開かないだけの側なので、広めに拾って実際の中身は検出側に任せる。
 */
export function isProjectManifestFile(fileNameOrPath: string): boolean {
  const name = fileNameOrPath.replace(/^.*[\\/]/, "");
  return MANIFEST_NAMES_LOWER.has(name.toLowerCase());
}

/** タスク種別に対応する Material Symbols のアイコン名。 */
export function taskIcon(kind: TaskKind): string {
  switch (kind) {
    case "run":
      return "play_arrow";
    case "stop":
      return "stop_circle";
    case "build":
      return "hardware";
    case "test":
      return "science";
    case "lint":
      return "rule";
    case "format":
      return "format_align_left";
    case "check":
      return "fact_check";
    case "clean":
      return "mop";
    case "install":
      return "download";
    default:
      return "terminal";
  }
}

/** マニフェスト種別に対応するアイコン名。 */
export function manifestIcon(kind: string): string {
  switch (kind) {
    case "node":
      return "javascript";
    case "rust":
      return "settings_b_roll";
    case "make":
      return "construction";
    case "docker":
      return "deployed_code";
    default:
      return "description";
  }
}

/** パス区切りの揺れ（`/` と `\`、末尾の区切り）を吸収して比較する。 */
export function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
    // Windows のパスは大文字小文字を区別しない。ドライブレター始まりのときだけ畳む。
    return /^[A-Za-z]:/.test(unified) ? unified.toLowerCase() : unified;
  };
  return normalize(a) === normalize(b);
}
