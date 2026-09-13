//! フォルダの中身から「クリックで実行できるタスク」を組み立てる。
//!
//! package.json のスクリプト、Cargo.toml のビルド/実行、Makefile のターゲット、
//! Compose / Dockerfile の起動コマンドを読み取り、フロント（プロジェクトタスク
//! パネル）が一覧表示できる形で返す。
//!
//! 実行そのものはここでは行わない。フロントがターミナル（PTY）へ `command` を
//! 書き込んでシェルに実行させる。つまり `command` はシェルにそのまま渡るので、
//! マニフェスト由来の文字列は必ず `quote_arg_for` を通し、安全に包めない文字を
//! 含むタスクは組み立てずに捨てる。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 上位フォルダを遡ってマニフェストを探す段数の上限。
const MAX_ANCESTOR_DEPTH: usize = 8;
/// マニフェストとして読むファイルサイズの上限（これを超えるものは無視する）。
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
/// 1 マニフェストあたりのタスク数の上限（巨大な Makefile などで一覧が壊れないように）。
const MAX_TASKS_PER_MANIFEST: usize = 120;
/// 補足表示（スクリプト本文）の最大文字数。
const MAX_DETAIL_CHARS: usize = 160;

// ── データ構造 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Build,
    Run,
    /// 動いているものを止める（compose down など）
    Stop,
    Test,
    Lint,
    Format,
    Check,
    Clean,
    Install,
    Script,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTask {
    /// マニフェスト内で一意な ID（"script:build" など）
    pub id: String,
    /// 一覧に出す短い名前（スクリプト名・ターゲット名・cargo のサブコマンド）
    pub label: String,
    /// スクリプト本文などの補足（無い場合は None）
    pub detail: Option<String>,
    /// ターミナルへ書き込むコマンド行（引用符の付与済み）
    pub command: String,
    pub kind: TaskKind,
    /// 開発サーバーのように起動したまま使うタスク（停止・再起動の導線を出す）
    pub long_running: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    /// "node" | "rust" | "make"
    pub kind: String,
    /// マニフェストの絶対パス
    pub file: String,
    /// 実行に使うツール名（"pnpm" / "cargo" / "make"）
    pub tool: String,
    /// プロジェクト名（読めた場合）
    pub name: Option<String>,
    pub tasks: Vec<ProjectTask>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTasks {
    /// 実際にマニフェストが見つかったフォルダ（見つからなければ問い合わせたフォルダ）
    pub dir: String,
    /// 上位フォルダを遡って見つけた場合は true
    pub from_ancestor: bool,
    /// 問い合わせたパスがローカルの実在フォルダだったか
    /// （クラウドや MTP のパスではシェルも組み込みサーバーも使えない）
    pub is_dir: bool,
    pub manifests: Vec<ProjectManifest>,
}

// ── シェル引用 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Posix,
    Cmd,
}

pub fn current_shell_kind() -> ShellKind {
    if cfg!(windows) {
        ShellKind::Cmd
    } else {
        ShellKind::Posix
    }
}

fn is_bare_safe(shell: ShellKind, arg: &str) -> bool {
    if arg.is_empty() {
        return false;
    }
    arg.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || match shell {
                ShellKind::Posix => {
                    matches!(c, '_' | '-' | '.' | ':' | '/' | '+' | '@' | '=' | ',')
                }
                // cmd.exe は '=' ',' ';' を引数の区切りとして扱うため裸では通さない
                ShellKind::Cmd => matches!(c, '_' | '-' | '.' | ':' | '/' | '+' | '@'),
            }
    })
}

/// 引数 1 個をシェルに渡せる形に包む。安全に包めない場合は None。
///
/// 制御文字は常に拒否する。改行が混じると「1 行のコマンド」ではなくなり、
/// ターミナルに書き込んだ時点で続きが別のコマンドとして実行されてしまうため。
pub fn quote_arg_for(shell: ShellKind, arg: &str) -> Option<String> {
    if arg.chars().any(|c| c.is_control()) {
        return None;
    }
    if is_bare_safe(shell, arg) {
        return Some(arg.to_string());
    }
    match shell {
        // シングルクォートの中は '\'' を除きすべて字義通り
        ShellKind::Posix => Some(format!("'{}'", arg.replace('\'', r"'\''"))),
        ShellKind::Cmd => {
            // cmd.exe / PowerShell のどちらかで二重引用符の中でも展開・終端される文字は
            // 包みようがないので、そのタスクは諦める。
            if arg.contains(['"', '%', '!', '$', '`']) {
                return None;
            }
            Some(format!("\"{}\"", arg))
        }
    }
}

/// プログラム名と引数からコマンド行を組み立てる。包めない引数があれば None。
pub fn shell_join_for(shell: ShellKind, program: &str, args: &[String]) -> Option<String> {
    let mut out = quote_arg_for(shell, program)?;
    for arg in args {
        out.push(' ');
        out.push_str(&quote_arg_for(shell, arg)?);
    }
    Some(out)
}

// ── 共通ヘルパ ──────────────────────────────────────────────────────────

fn read_manifest(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn truncate_detail(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 表示用なので制御文字（改行を含む）は空白に潰す
    let flat: String = trimmed
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut out = String::new();
    for (i, c) in flat.chars().enumerate() {
        if i >= MAX_DETAIL_CHARS {
            out.push('…');
            break;
        }
        out.push(c);
    }
    Some(out)
}

fn make_task(
    id: String,
    label: String,
    detail: Option<String>,
    program: &str,
    args: &[&str],
    kind: TaskKind,
    long_running: bool,
) -> Option<ProjectTask> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let command = shell_join_for(current_shell_kind(), program, &owned)?;
    Some(ProjectTask {
        id,
        label,
        detail,
        command,
        kind,
        long_running,
    })
}

/// 起動しっぱなしで使うタスクか（開発サーバー・ウォッチ）。
///
/// 名前だけでは `build:watch` のようなものを取りこぼすので、スクリプト本文も見る。
pub fn is_long_running(name: &str, body: Option<&str>, kind: TaskKind) -> bool {
    if kind == TaskKind::Run {
        return true;
    }
    let haystack = format!("{} {}", name, body.unwrap_or("")).to_lowercase();
    ["--watch", " -w ", "watch", "nodemon", "serve", "--hot"]
        .iter()
        .any(|needle| haystack.contains(needle))
}

// ── package.json ────────────────────────────────────────────────────────

/// package.json のスクリプト名からタスク種別を推測する（アイコンと並びに使うだけ）。
pub fn classify_script(name: &str) -> TaskKind {
    let n = name.to_lowercase();
    let has = |k: &str| n.contains(k);
    if has("lint") || has("clippy") || has("eslint") {
        TaskKind::Lint
    } else if has("format") || has("fmt") || has("prettier") {
        TaskKind::Format
    } else if has("test") || has("spec") || has("e2e") {
        TaskKind::Test
    } else if has("build") || has("bundle") || has("compile") || has("dist") {
        TaskKind::Build
    } else if has("clean") {
        TaskKind::Clean
    } else if has("typecheck") || has("check") || has("tsc") {
        TaskKind::Check
    } else if has("dev") || has("start") || has("serve") || has("preview") || has("watch") {
        TaskKind::Run
    } else {
        TaskKind::Script
    }
}

/// 使うパッケージマネージャを決める。
///
/// package.json の packageManager 欄を最優先し、無ければロックファイルを見る。
/// モノレポではロックファイルがリポジトリのルートにしか無いことがあるので、
/// 見つかるまで上位フォルダも辿る。
pub fn detect_node_pm(dir: &Path, declared: Option<&str>) -> &'static str {
    if let Some(d) = declared {
        let name = d.split('@').next().unwrap_or("").trim().to_lowercase();
        match name.as_str() {
            "pnpm" => return "pnpm",
            "yarn" => return "yarn",
            "bun" => return "bun",
            "npm" => return "npm",
            _ => {}
        }
    }
    let mut current = Some(dir);
    for _ in 0..MAX_ANCESTOR_DEPTH {
        let Some(d) = current else { break };
        for (lock, pm) in [
            ("pnpm-lock.yaml", "pnpm"),
            ("bun.lockb", "bun"),
            ("bun.lock", "bun"),
            ("yarn.lock", "yarn"),
            ("package-lock.json", "npm"),
            ("npm-shrinkwrap.json", "npm"),
        ] {
            if d.join(lock).is_file() {
                return pm;
            }
        }
        current = d.parent();
    }
    "npm"
}

/// package.json を読む。
///
/// 他人が書いたファイルなので、型が想定と違っても（name が数値、scripts が配列など）
/// 読める部分だけ拾う。struct へ一括で deserialize すると、1 箇所の食い違いで
/// プロジェクト全体のタスクが出なくなってしまう。
fn parse_package_json(dir: &Path, content: &str) -> Option<ProjectManifest> {
    let root: serde_json::Value = serde_json::from_str(content).ok()?;
    let obj = root.as_object()?;
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let pm = detect_node_pm(dir, obj.get("packageManager").and_then(|v| v.as_str()));

    // serde_json のオブジェクトは読み込み順にも辞書順にもなりうる。
    // 並びが環境で変わらないよう明示的に揃える。
    let scripts: BTreeMap<&String, &serde_json::Value> = obj
        .get("scripts")
        .and_then(|v| v.as_object())
        .map(|m| m.iter().collect())
        .unwrap_or_default();

    let mut tasks: Vec<ProjectTask> = Vec::new();
    for (name, body) in scripts {
        if tasks.len() >= MAX_TASKS_PER_MANIFEST {
            break;
        }
        let raw_body = body.as_str();
        let detail = raw_body.and_then(truncate_detail);
        let kind = classify_script(name);
        if let Some(task) = make_task(
            format!("script:{name}"),
            name.clone(),
            detail,
            pm,
            &["run", name],
            kind,
            is_long_running(name, raw_body, kind),
        ) {
            tasks.push(task);
        }
    }

    // 依存の導入はどのプロジェクトでも最初に必要になるので常に出す
    if let Some(task) = make_task(
        "install".to_string(),
        format!("{pm} install"),
        None,
        pm,
        &["install"],
        TaskKind::Install,
        false,
    ) {
        tasks.push(task);
    }

    Some(ProjectManifest {
        kind: "node".to_string(),
        file: dir.join("package.json").to_string_lossy().to_string(),
        tool: pm.to_string(),
        name,
        tasks,
    })
}

// ── Cargo.toml ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CargoToml {
    package: Option<CargoPackage>,
    #[serde(default)]
    bin: Vec<CargoTarget>,
    #[serde(default)]
    example: Vec<CargoTarget>,
    workspace: Option<toml::Value>,
}

#[derive(Deserialize)]
struct CargoPackage {
    name: Option<String>,
}

#[derive(Deserialize)]
struct CargoTarget {
    name: Option<String>,
}

fn parse_cargo_toml(dir: &Path, content: &str, has_main_rs: bool) -> Option<ProjectManifest> {
    let cargo: CargoToml = toml::from_str(content).ok()?;
    // [package] を持たない仮想マニフェスト（ワークスペースのルート）は
    // 実行対象のバイナリを持たないので、ビルド/テスト系だけを出す。
    let is_virtual = cargo.package.is_none() && cargo.workspace.is_some();
    let runnable = !is_virtual && (has_main_rs || !cargo.bin.is_empty());

    let mut tasks: Vec<ProjectTask> = Vec::new();
    let mut push = |id: &str, label: &str, args: &[&str], kind: TaskKind| {
        if let Some(task) = make_task(
            id.to_string(),
            label.to_string(),
            None,
            "cargo",
            args,
            kind,
            kind == TaskKind::Run,
        ) {
            tasks.push(task);
        }
    };

    if runnable {
        // デバッグ実行を最上段に置く（「ビルドしてすぐ動かす」が一番よく使うため）
        push("run", "run", &["run"], TaskKind::Run);
        push(
            "run-release",
            "run --release",
            &["run", "--release"],
            TaskKind::Run,
        );
    }
    push("build", "build", &["build"], TaskKind::Build);
    push(
        "build-release",
        "build --release",
        &["build", "--release"],
        TaskKind::Build,
    );
    push("test", "test", &["test"], TaskKind::Test);
    push("check", "check", &["check"], TaskKind::Check);
    push(
        "clippy",
        "clippy",
        &["clippy", "--all-targets"],
        TaskKind::Lint,
    );
    push("fmt", "fmt", &["fmt"], TaskKind::Format);

    // バイナリが複数あるときは名前を指定しないと cargo run が失敗するので個別に出す
    if cargo.bin.len() > 1 {
        for target in &cargo.bin {
            let Some(name) = target.name.as_deref() else {
                continue;
            };
            if tasks.len() >= MAX_TASKS_PER_MANIFEST {
                break;
            }
            if let Some(task) = make_task(
                format!("run-bin:{name}"),
                format!("run --bin {name}"),
                None,
                "cargo",
                &["run", "--bin", name],
                TaskKind::Run,
                true,
            ) {
                tasks.push(task);
            }
        }
    }
    for target in &cargo.example {
        let Some(name) = target.name.as_deref() else {
            continue;
        };
        if tasks.len() >= MAX_TASKS_PER_MANIFEST {
            break;
        }
        if let Some(task) = make_task(
            format!("run-example:{name}"),
            format!("run --example {name}"),
            None,
            "cargo",
            &["run", "--example", name],
            TaskKind::Run,
            true,
        ) {
            tasks.push(task);
        }
    }

    Some(ProjectManifest {
        kind: "rust".to_string(),
        file: dir.join("Cargo.toml").to_string_lossy().to_string(),
        tool: "cargo".to_string(),
        name: cargo.package.and_then(|p| p.name),
        tasks,
    })
}

// ── Makefile ────────────────────────────────────────────────────────────

/// Makefile から実行できるターゲット名を行順に取り出す。
///
/// レシピ行（タブ始まり）・変数代入・パターンルール・`.PHONY` などの特殊ターゲットは
/// 対象外。`make` を呼ばずに済ませるための割り切った読み方で、変数展開は解釈しない。
pub fn parse_makefile_targets(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in content.lines() {
        if line.starts_with('\t') || line.trim().is_empty() {
            continue;
        }
        let line = line.trim_end();
        if line.trim_start().starts_with('#') {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
        // `VAR := x` / `VAR ::= x` は代入
        if line[colon + 1..].starts_with('=') {
            continue;
        }
        let head = &line[..colon];
        // `VAR = target: x` のような代入の右辺を拾わない
        if head.contains('=') {
            continue;
        }
        // 変数展開や関数呼び出しを含む行は正しく読めないので触らない
        if head.contains('$') {
            continue;
        }
        for name in head.split_whitespace() {
            // `.PHONY` などの特殊ターゲットと `%.o` のようなパターンルールは実行対象外
            if name.starts_with('.') || name.contains('%') {
                continue;
            }
            if out.iter().any(|t| t == name) {
                continue;
            }
            out.push(name.to_string());
            if out.len() >= MAX_TASKS_PER_MANIFEST {
                return out;
            }
        }
    }
    out
}

fn parse_makefile(dir: &Path, file_name: &str, content: &str) -> Option<ProjectManifest> {
    let targets = parse_makefile_targets(content);
    if targets.is_empty() {
        return None;
    }
    let tasks: Vec<ProjectTask> = targets
        .iter()
        .filter_map(|name| {
            let kind = classify_script(name);
            make_task(
                format!("target:{name}"),
                name.clone(),
                None,
                "make",
                &[name],
                kind,
                is_long_running(name, None, kind),
            )
        })
        .collect();
    if tasks.is_empty() {
        return None;
    }
    Some(ProjectManifest {
        kind: "make".to_string(),
        file: dir.join(file_name).to_string_lossy().to_string(),
        tool: "make".to_string(),
        name: None,
        tasks,
    })
}

// ── Docker（Compose / Dockerfile） ──────────────────────────────────────

/// Compose ファイルの候補。Compose 仕様の優先順で並べる（先に見つかった 1 つを使う）。
const COMPOSE_FILES: &[&str] = &[
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];

/// 個別に起動できるようにするサービス数の上限（サービスが多いと一覧が埋まる）。
const MAX_COMPOSE_SERVICES: usize = 12;

/// Compose ファイルからサービス名を取り出す。読めなければ空。
///
/// 起動そのものは `docker compose` に任せるので、ここで読むのは一覧に出す
/// サービス名だけ。拡張タグなどで解釈できないファイルでも、全体を対象にした
/// up / down は出したいので、失敗しても空を返して続ける。
pub fn parse_compose_services(content: &str) -> Vec<String> {
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(content) else {
        return Vec::new();
    };
    let Some(services) = value.get("services").and_then(|s| s.as_mapping()) else {
        return Vec::new();
    };
    services
        .keys()
        .filter_map(|k| k.as_str().map(|s| s.to_string()))
        .filter(|name| !name.trim().is_empty())
        .take(MAX_COMPOSE_SERVICES)
        .collect()
}

fn parse_compose(dir: &Path, file_name: &str, content: &str) -> Option<ProjectManifest> {
    let mut tasks: Vec<ProjectTask> = Vec::new();
    let mut push = |id: &str, label: &str, args: &[&str], kind: TaskKind, long_running: bool| {
        if let Some(task) = make_task(
            id.to_string(),
            label.to_string(),
            None,
            "docker",
            args,
            kind,
            long_running,
        ) {
            tasks.push(task);
        }
    };

    // 前面で起動（ログがそのまま流れ、Ctrl+C で止まる）→ パネルのシェルと相性が良い
    push("up", "up", &["compose", "up"], TaskKind::Run, true);
    // 裏で起動（すぐプロンプトに戻る）
    push(
        "up-detached",
        "up -d",
        &["compose", "up", "-d"],
        TaskKind::Run,
        false,
    );
    push("down", "down", &["compose", "down"], TaskKind::Stop, false);
    push(
        "build",
        "build",
        &["compose", "build"],
        TaskKind::Build,
        false,
    );
    push("ps", "ps", &["compose", "ps"], TaskKind::Check, false);
    push(
        "logs",
        "logs -f",
        &["compose", "logs", "-f"],
        TaskKind::Script,
        true,
    );

    // サービス単体の起動。1 つしか無いときは全体の up と同じなので出さない。
    let services = parse_compose_services(content);
    if services.len() > 1 {
        for name in &services {
            if tasks.len() >= MAX_TASKS_PER_MANIFEST {
                break;
            }
            if let Some(task) = make_task(
                format!("up:{name}"),
                format!("up {name}"),
                None,
                "docker",
                &["compose", "up", name],
                TaskKind::Run,
                true,
            ) {
                tasks.push(task);
            }
        }
    }

    Some(ProjectManifest {
        kind: "docker".to_string(),
        file: dir.join(file_name).to_string_lossy().to_string(),
        tool: "docker compose".to_string(),
        name: None,
        tasks,
    })
}

/// フォルダ名からイメージのタグを作る。使える文字が残らなければ None。
///
/// タグは英小文字・数字と `.` `_` `-` しか使えず、先頭は英数字である必要がある。
pub fn image_tag_from_dir(dir: &Path) -> Option<String> {
    let raw = dir.file_name()?.to_string_lossy().to_lowercase();
    let mut tag = String::new();
    for c in raw.chars() {
        // 記号は先頭に置けない（タグは英数字で始まる必要がある）
        let usable = c.is_ascii_alphanumeric() || (matches!(c, '.' | '_' | '-') && !tag.is_empty());
        if usable {
            tag.push(c);
        }
        if tag.len() >= 64 {
            break;
        }
    }
    let trimmed = tag.trim_end_matches(['.', '_', '-']).to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn parse_dockerfile(dir: &Path) -> Option<ProjectManifest> {
    // タグを作れないフォルダ名（記号だけ等）では、タグ無しで組み立てる
    let tag = image_tag_from_dir(dir);
    let mut tasks: Vec<ProjectTask> = Vec::new();

    let build_args: Vec<&str> = match tag.as_deref() {
        Some(t) => vec!["build", "-t", t, "."],
        None => vec!["build", "."],
    };
    if let Some(task) = make_task(
        "build".to_string(),
        match tag.as_deref() {
            Some(t) => format!("build -t {t}"),
            None => "build".to_string(),
        },
        None,
        "docker",
        &build_args,
        TaskKind::Build,
        false,
    ) {
        tasks.push(task);
    }

    // 実行はタグが要る。--rm で使い捨て、-it で入力を渡す（シェル入りイメージ向け）
    if let Some(t) = tag.as_deref() {
        if let Some(task) = make_task(
            "run".to_string(),
            format!("run {t}"),
            None,
            "docker",
            &["run", "--rm", "-it", t],
            TaskKind::Run,
            true,
        ) {
            tasks.push(task);
        }
    }

    if tasks.is_empty() {
        return None;
    }
    Some(ProjectManifest {
        kind: "docker".to_string(),
        file: dir.join("Dockerfile").to_string_lossy().to_string(),
        tool: "docker".to_string(),
        name: tag,
        tasks,
    })
}

// ── 検出 ────────────────────────────────────────────────────────────────

/// 指定フォルダ「だけ」を見てマニフェストを集める（上位は辿らない）。
fn detect_in_dir(dir: &Path) -> Vec<ProjectManifest> {
    let mut manifests = Vec::new();

    if let Some(content) = read_manifest(&dir.join("package.json")) {
        if let Some(m) = parse_package_json(dir, &content) {
            manifests.push(m);
        }
    }

    if let Some(content) = read_manifest(&dir.join("Cargo.toml")) {
        let has_main_rs = dir.join("src").join("main.rs").is_file();
        if let Some(m) = parse_cargo_toml(dir, &content, has_main_rs) {
            manifests.push(m);
        }
    }

    for name in ["Makefile", "makefile", "GNUmakefile"] {
        if let Some(content) = read_manifest(&dir.join(name)) {
            if let Some(m) = parse_makefile(dir, name, &content) {
                manifests.push(m);
                break;
            }
        }
    }

    // Compose は仕様の優先順で最初に見つかった 1 つだけを使う
    for name in COMPOSE_FILES {
        if let Some(content) = read_manifest(&dir.join(name)) {
            if let Some(m) = parse_compose(dir, name, &content) {
                manifests.push(m);
                break;
            }
        }
    }

    // Compose と Dockerfile は同居する（Compose 経由と単体ビルドの両方を出す）
    if dir.join("Dockerfile").is_file() {
        if let Some(m) = parse_dockerfile(dir) {
            manifests.push(m);
        }
    }

    manifests
}

/// フォルダ（必要なら上位フォルダ）からタスクを検出する。
///
/// パネルが表示中のフォルダごとに呼ぶので、フォルダが無い・読めない場合も
/// エラーにはせず「タスク無し」を返す。
#[tauri::command(async)]
pub fn detect_project_tasks(
    dir: String,
    search_ancestors: Option<bool>,
) -> Result<ProjectTasks, String> {
    let search_ancestors = search_ancestors.unwrap_or(true);
    let mut empty = ProjectTasks {
        dir: dir.clone(),
        from_ancestor: false,
        is_dir: false,
        manifests: Vec::new(),
    };
    if dir.trim().is_empty() {
        return Ok(empty);
    }
    let start = PathBuf::from(&dir);
    if !start.is_dir() {
        return Ok(empty);
    }
    empty.is_dir = true;

    let mut current = Some(start);
    for depth in 0..MAX_ANCESTOR_DEPTH {
        let Some(d) = current else { break };
        let manifests = detect_in_dir(&d);
        if !manifests.is_empty() {
            return Ok(ProjectTasks {
                dir: d.to_string_lossy().to_string(),
                from_ancestor: depth > 0,
                is_dir: true,
                manifests,
            });
        }
        if !search_ancestors {
            break;
        }
        // リポジトリの外（ホームフォルダなど）まで遡ると無関係なタスクを拾うため、
        // リポジトリのルートを見終えたら打ち切る。
        if d.join(".git").exists() {
            break;
        }
        current = d.parent().map(|p| p.to_path_buf());
    }

    Ok(empty)
}

// ── テスト ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── シェル引用 ──────────────────────────────────────────────────
    // command はターミナル（シェル）へそのまま書き込まれる。マニフェストは
    // 他人が書いたファイルなので、ここが実行内容を決める最後の砦になる。

    #[test]
    fn leaves_ordinary_names_unquoted() {
        for name in ["build", "test:unit", "lint-fix", "src/main.rs"] {
            assert_eq!(
                quote_arg_for(ShellKind::Posix, name),
                Some(name.to_string())
            );
        }
    }

    #[test]
    fn quotes_shell_metacharacters_instead_of_letting_them_run() {
        // `;` や `$(…)` をそのまま渡すと別のコマンドが動いてしまう
        let quoted = quote_arg_for(ShellKind::Posix, "build; rm -rf /").unwrap();
        assert_eq!(quoted, "'build; rm -rf /'");
        let quoted = quote_arg_for(ShellKind::Posix, "$(id)").unwrap();
        assert_eq!(quoted, "'$(id)'");
    }

    #[test]
    fn escapes_single_quotes_so_the_quoting_cannot_be_broken_out_of() {
        let quoted = quote_arg_for(ShellKind::Posix, "a'; id; echo '").unwrap();
        assert_eq!(quoted, r"'a'\''; id; echo '\'''");
    }

    #[test]
    fn rejects_control_characters_on_every_shell() {
        // 改行が通ると「続き」が別の行として実行されてしまう
        for shell in [ShellKind::Posix, ShellKind::Cmd] {
            assert_eq!(quote_arg_for(shell, "build\nid"), None);
            assert_eq!(quote_arg_for(shell, "build\rid"), None);
        }
    }

    #[test]
    fn quotes_for_cmd_and_gives_up_on_expandable_characters() {
        assert_eq!(
            quote_arg_for(ShellKind::Cmd, "build all"),
            Some("\"build all\"".to_string())
        );
        // cmd.exe は '=' ',' を引数の区切りにするので裸では通さない
        assert_eq!(
            quote_arg_for(ShellKind::Cmd, "a=b"),
            Some("\"a=b\"".to_string())
        );
        // 二重引用符の中でも展開される・終端される文字は諦める
        for bad in ["%PATH%", "a\"b", "!x!", "$env:x", "`id`"] {
            assert_eq!(quote_arg_for(ShellKind::Cmd, bad), None, "通した: {bad}");
        }
    }

    #[test]
    fn join_fails_when_any_argument_cannot_be_quoted() {
        assert_eq!(
            shell_join_for(ShellKind::Posix, "npm", &["run".into(), "build".into()]),
            Some("npm run build".to_string())
        );
        assert_eq!(
            shell_join_for(ShellKind::Posix, "npm", &["run".into(), "a\nb".into()]),
            None
        );
    }

    // ── package.json ────────────────────────────────────────────────

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("shirube-task-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_package_json_scripts_and_adds_install() {
        let dir = tmpdir("pkg");
        let content =
            r#"{ "name": "demo", "scripts": { "build": "tsc && vite build", "dev": "vite" } }"#;
        let m = parse_package_json(&dir, content).unwrap();
        assert_eq!(m.kind, "node");
        assert_eq!(m.name.as_deref(), Some("demo"));
        let labels: Vec<&str> = m.tasks.iter().map(|t| t.label.as_str()).collect();
        assert!(labels.contains(&"build"));
        assert!(labels.contains(&"dev"));
        assert!(labels.iter().any(|l| l.ends_with(" install")));
        let build = m.tasks.iter().find(|t| t.label == "build").unwrap();
        assert_eq!(build.detail.as_deref(), Some("tsc && vite build"));
        assert_eq!(build.kind, TaskKind::Build);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_reading_a_package_json_whose_fields_have_odd_types() {
        let dir = tmpdir("pkg-odd");
        // name が文字列でなくても scripts は読めるべき
        let content = r#"{ "name": 42, "scripts": { "build": "tsc" } }"#;
        let m = parse_package_json(&dir, content).unwrap();
        assert_eq!(m.name, None);
        assert!(m.tasks.iter().any(|t| t.label == "build"));

        // scripts がオブジェクトでなければスクリプトは無し（導入タスクだけ残る）
        let m = parse_package_json(&dir, r#"{ "scripts": ["build"] }"#).unwrap();
        assert_eq!(m.tasks.len(), 1);
        assert_eq!(m.tasks[0].kind, TaskKind::Install);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drops_scripts_whose_name_cannot_be_passed_to_a_shell() {
        let dir = tmpdir("pkg-bad");
        // 改行入りのスクリプト名を通すと、ターミナルで 2 行目が実行されてしまう
        let content = r#"{ "scripts": { "build\nid": "x", "ok": "y" } }"#;
        let m = parse_package_json(&dir, content).unwrap();
        let labels: Vec<&str> = m.tasks.iter().map(|t| t.label.as_str()).collect();
        assert!(labels.contains(&"ok"));
        assert!(!labels.iter().any(|l| l.contains('\n')));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn marks_dev_servers_and_watchers_as_long_running() {
        let dir = tmpdir("pkg-watch");
        let content = r#"{ "scripts": {
            "dev": "vite",
            "build": "tsc && vite build",
            "build:watch": "tsc --watch",
            "test": "vitest run"
        } }"#;
        let m = parse_package_json(&dir, content).unwrap();
        let long_running = |label: &str| {
            m.tasks
                .iter()
                .find(|t| t.label == label)
                .unwrap()
                .long_running
        };
        assert!(long_running("dev"));
        // 名前では分からないウォッチも本文から拾う
        assert!(long_running("build:watch"));
        assert!(!long_running("build"));
        assert!(!long_running("test"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn treats_cargo_run_as_long_running_but_not_cargo_build() {
        let dir = tmpdir("cargo-longrun");
        let m = parse_cargo_toml(&dir, "[package]\nname = \"demo\"\n", true).unwrap();
        let by_label = |label: &str| m.tasks.iter().find(|t| t.label == label).unwrap();
        assert!(by_label("run").long_running);
        assert!(!by_label("build").long_running);
        assert!(!by_label("test").long_running);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uses_the_package_manager_the_project_declares() {
        let dir = tmpdir("pkg-pm");
        let content = r#"{ "packageManager": "pnpm@9.1.0", "scripts": { "build": "x" } }"#;
        let m = parse_package_json(&dir, content).unwrap();
        assert_eq!(m.tool, "pnpm");
        let build = m.tasks.iter().find(|t| t.label == "build").unwrap();
        assert_eq!(build.command, "pnpm run build");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn falls_back_to_the_lockfile_in_a_parent_folder() {
        let root = tmpdir("pkg-lock");
        std::fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
        let pkg_dir = root.join("packages").join("app");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        assert_eq!(detect_node_pm(&pkg_dir, None), "pnpm");
        assert_eq!(detect_node_pm(&pkg_dir, Some("yarn@4.0.0")), "yarn");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── Cargo.toml ──────────────────────────────────────────────────

    #[test]
    fn offers_debug_run_first_for_a_binary_crate() {
        let dir = tmpdir("cargo-bin");
        let content = "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n";
        let m = parse_cargo_toml(&dir, content, true).unwrap();
        assert_eq!(m.name.as_deref(), Some("demo"));
        assert_eq!(m.tasks[0].label, "run");
        assert_eq!(m.tasks[0].command, "cargo run");
        let labels: Vec<&str> = m.tasks.iter().map(|t| t.label.as_str()).collect();
        for expected in ["run --release", "build", "test", "check", "clippy", "fmt"] {
            assert!(labels.contains(&expected), "欠けている: {expected}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn does_not_offer_run_for_a_library_crate() {
        let dir = tmpdir("cargo-lib");
        let content = "[package]\nname = \"lib-only\"\n";
        let m = parse_cargo_toml(&dir, content, false).unwrap();
        assert!(m.tasks.iter().all(|t| !t.label.starts_with("run")));
        assert!(m.tasks.iter().any(|t| t.label == "build"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_each_binary_when_the_crate_has_several() {
        let dir = tmpdir("cargo-bins");
        let content = "[package]\nname = \"multi\"\n\n[[bin]]\nname = \"cli\"\n\n[[bin]]\nname = \"daemon\"\n";
        let m = parse_cargo_toml(&dir, content, false).unwrap();
        let labels: Vec<&str> = m.tasks.iter().map(|t| t.label.as_str()).collect();
        assert!(labels.contains(&"run --bin cli"));
        assert!(labels.contains(&"run --bin daemon"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn treats_a_virtual_workspace_manifest_as_not_runnable() {
        let dir = tmpdir("cargo-ws");
        let content = "[workspace]\nmembers = [\"a\", \"b\"]\n";
        let m = parse_cargo_toml(&dir, content, false).unwrap();
        assert!(m.tasks.iter().all(|t| !t.label.starts_with("run")));
        assert!(m.tasks.iter().any(|t| t.label == "test"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Makefile ────────────────────────────────────────────────────

    #[test]
    fn reads_makefile_targets_in_file_order() {
        let content = "\
.PHONY: check build
CFLAGS := -O2
OUT = out: not-a-target

check:
\tcargo check

build: check
\tcargo build

%.o: %.c
\tcc -c $<

$(BIN): build
\techo $@
";
        let targets = parse_makefile_targets(content);
        assert_eq!(targets, vec!["check", "build"]);
    }

    #[test]
    fn reads_several_targets_declared_on_one_line() {
        let targets = parse_makefile_targets("build test:\n\techo hi\n");
        assert_eq!(targets, vec!["build", "test"]);
    }

    #[test]
    fn ignores_a_makefile_without_targets() {
        let dir = tmpdir("make-empty");
        assert!(parse_makefile(&dir, "Makefile", "CFLAGS := -O2\n").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Docker ──────────────────────────────────────────────────────

    #[test]
    fn offers_compose_start_and_stop() {
        let dir = tmpdir("compose");
        let yaml = "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n";
        let m = parse_compose(&dir, "compose.yaml", yaml).unwrap();
        assert_eq!(m.kind, "docker");
        assert_eq!(m.tool, "docker compose");

        let by_label = |label: &str| m.tasks.iter().find(|t| t.label == label);
        // 前面起動はログが流れ続けるので「実行中」扱い、-d はすぐ戻るので違う
        let up = by_label("up").expect("up が無い");
        assert_eq!(up.command, "docker compose up");
        assert!(up.long_running);
        let detached = by_label("up -d").expect("up -d が無い");
        assert!(!detached.long_running);
        let down = by_label("down").expect("down が無い");
        assert_eq!(down.kind, TaskKind::Stop);
        assert!(!down.long_running);
        for label in ["build", "ps", "logs -f"] {
            assert!(by_label(label).is_some(), "欠けている: {label}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_each_compose_service_so_one_can_be_started_alone() {
        let dir = tmpdir("compose-services");
        let yaml = "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n";
        let m = parse_compose(&dir, "compose.yaml", yaml).unwrap();
        let labels: Vec<&str> = m.tasks.iter().map(|t| t.label.as_str()).collect();
        assert!(labels.contains(&"up web"));
        assert!(labels.contains(&"up db"));
        let web = m.tasks.iter().find(|t| t.label == "up web").unwrap();
        assert_eq!(web.command, "docker compose up web");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn does_not_repeat_a_single_service_as_its_own_entry() {
        // サービスが 1 つなら「up」と同じ意味になるので増やさない
        let dir = tmpdir("compose-single");
        let m = parse_compose(
            &dir,
            "compose.yaml",
            "services:\n  web:\n    image: nginx\n",
        )
        .unwrap();
        assert!(m.tasks.iter().all(|t| !t.label.starts_with("up web")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn still_offers_compose_commands_when_the_file_cannot_be_parsed() {
        // 拡張タグなどで読めなくても、全体の up / down は出せる
        let dir = tmpdir("compose-broken");
        let m = parse_compose(&dir, "compose.yaml", "services: [this is not a mapping\n").unwrap();
        assert!(m.tasks.iter().any(|t| t.label == "up"));
        // サービス名が読めないので、サービス単体の項目（id が "up:"）は出ない
        assert!(m.tasks.iter().all(|t| !t.id.starts_with("up:")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_service_names_without_choking_on_extras() {
        // 上限までに切り詰める（サービスが多いと一覧が埋まる）
        let many: String = (0..30)
            .map(|i| format!("  svc{i}:\n    image: busybox\n"))
            .collect();
        let services = parse_compose_services(&format!("services:\n{many}"));
        assert_eq!(services.len(), MAX_COMPOSE_SERVICES);
        assert_eq!(services[0], "svc0");
        // services が無い YAML では空
        assert!(parse_compose_services("version: \"3\"\n").is_empty());
        assert!(parse_compose_services("").is_empty());
    }

    #[test]
    fn builds_and_runs_a_dockerfile_with_a_tag_from_the_folder_name() {
        let dir = tmpdir("My App");
        std::fs::write(dir.join("Dockerfile"), "FROM alpine\n").unwrap();
        let m = parse_dockerfile(&dir).unwrap();
        assert_eq!(m.kind, "docker");
        assert_eq!(m.tool, "docker");

        let tag = m.name.clone().expect("タグが付かなかった");
        // タグは英小文字・数字と . _ - だけ（大文字や空白はそのまま使えない）
        assert!(
            tag.chars().all(|c| c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || matches!(c, '.' | '_' | '-')),
            "使えない文字が残っている: {tag}"
        );
        let build = m.tasks.iter().find(|t| t.kind == TaskKind::Build).unwrap();
        assert!(
            build.command.starts_with("docker build -t "),
            "{}",
            build.command
        );
        assert!(build.command.ends_with(" ."), "{}", build.command);
        let run = m.tasks.iter().find(|t| t.kind == TaskKind::Run).unwrap();
        assert!(run.command.contains("--rm"));
        assert!(run.long_running);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn makes_a_usable_image_tag_or_gives_up() {
        assert_eq!(
            image_tag_from_dir(Path::new("/a/My App")).as_deref(),
            Some("myapp")
        );
        assert_eq!(
            image_tag_from_dir(Path::new("/a/web-front_2")).as_deref(),
            Some("web-front_2")
        );
        // 先頭の記号は落とし、末尾の記号も残さない
        assert_eq!(
            image_tag_from_dir(Path::new("/a/--edge--")).as_deref(),
            Some("edge")
        );
        // 使える文字が残らなければタグ無し（build だけ出す）
        assert_eq!(image_tag_from_dir(Path::new("/a/++")), None);
    }

    #[test]
    fn builds_without_a_tag_when_the_folder_name_has_nothing_usable() {
        let dir = tmpdir("plain");
        let odd = dir.join("++");
        std::fs::create_dir_all(&odd).unwrap();
        std::fs::write(odd.join("Dockerfile"), "FROM alpine\n").unwrap();
        let m = parse_dockerfile(&odd).unwrap();
        assert_eq!(m.name, None);
        assert_eq!(m.tasks.len(), 1);
        assert_eq!(m.tasks[0].command, "docker build .");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_compose_and_dockerfile_side_by_side() {
        let dir = tmpdir("docker-both");
        std::fs::write(
            dir.join("docker-compose.yml"),
            "services:\n  web:\n    build: .\n",
        )
        .unwrap();
        std::fs::write(dir.join("Dockerfile"), "FROM alpine\n").unwrap();
        let found = detect_project_tasks(dir.to_string_lossy().to_string(), Some(false)).unwrap();
        let tools: Vec<&str> = found.manifests.iter().map(|m| m.tool.as_str()).collect();
        assert_eq!(tools, vec!["docker compose", "docker"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uses_only_the_first_compose_file_by_spec_order() {
        let dir = tmpdir("compose-order");
        // 両方あるときは compose.yaml が優先（Compose 仕様の順）
        std::fs::write(
            dir.join("compose.yaml"),
            "services:\n  a:\n    image: busybox\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("docker-compose.yml"),
            "services:\n  b:\n    image: busybox\n",
        )
        .unwrap();
        let found = detect_project_tasks(dir.to_string_lossy().to_string(), Some(false)).unwrap();
        let compose: Vec<&ProjectManifest> = found
            .manifests
            .iter()
            .filter(|m| m.kind == "docker")
            .collect();
        assert_eq!(compose.len(), 1);
        assert!(
            compose[0].file.ends_with("compose.yaml"),
            "{}",
            compose[0].file
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 検出 ────────────────────────────────────────────────────────

    #[test]
    fn finds_the_project_from_a_subfolder() {
        let root = tmpdir("detect");
        std::fs::write(root.join("package.json"), r#"{"scripts":{"build":"x"}}"#).unwrap();
        let sub = root.join("src").join("components");
        std::fs::create_dir_all(&sub).unwrap();

        let found = detect_project_tasks(sub.to_string_lossy().to_string(), Some(true)).unwrap();
        assert!(found.from_ancestor);
        assert_eq!(found.dir, root.to_string_lossy());
        assert_eq!(found.manifests.len(), 1);

        // 上位を辿らない指定なら、そのフォルダに無い限り何も返さない
        let direct = detect_project_tasks(sub.to_string_lossy().to_string(), Some(false)).unwrap();
        assert!(direct.manifests.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stops_climbing_at_the_repository_root() {
        let outer = tmpdir("detect-stop");
        std::fs::write(outer.join("package.json"), r#"{"scripts":{"build":"x"}}"#).unwrap();
        let repo = outer.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let sub = repo.join("src");
        std::fs::create_dir_all(&sub).unwrap();

        let found = detect_project_tasks(sub.to_string_lossy().to_string(), Some(true)).unwrap();
        assert!(
            found.manifests.is_empty(),
            "リポジトリの外の package.json を拾っている: {:?}",
            found.dir
        );
        let _ = std::fs::remove_dir_all(&outer);
    }

    #[test]
    fn returns_nothing_for_a_path_that_is_not_a_folder() {
        // クラウドのパスではシェルもサーバーも開けないので is_dir で知らせる
        let found = detect_project_tasks(String::new(), Some(true)).unwrap();
        assert!(found.manifests.is_empty());
        assert!(!found.is_dir);
        let found = detect_project_tasks("s3://bucket/prefix".to_string(), Some(true)).unwrap();
        assert!(found.manifests.is_empty());
        assert!(!found.is_dir);
    }

    #[test]
    fn reports_a_real_folder_even_without_any_manifest() {
        let dir = tmpdir("plain-folder");
        std::fs::write(dir.join("index.html"), "<h1>hi</h1>").unwrap();
        let found = detect_project_tasks(dir.to_string_lossy().to_string(), Some(false)).unwrap();
        assert!(found.manifests.is_empty());
        assert!(found.is_dir, "素のフォルダを使えない扱いにしている");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
