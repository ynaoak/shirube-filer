use crate::progress::{CancelState, ProgressPayload};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use jwalk::WalkDir as JWalkDir;

/// 進捗イベントの最短送信間隔。
/// 小さなファイルが大量にある場合、1 ファイルごとに emit すると IPC と
/// フロントの再描画が詰まって UI が固まるため、この間隔まで間引く。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Basic sanity checks applied to every path parameter coming from the frontend.
fn validate_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("パスにNULLバイトは使用できません".to_string());
    }
    // MTP（スマホ等）の仮想パスは通常のファイルシステムには存在しない。ここへ
    // 届くのはフロントの振り分け漏れなので、絶対パス扱いで弾く前に理由の分かる
    // メッセージを返す（"絶対パスを指定してください: mtp://..." では追えない）。
    if crate::mtp_commands::is_mtp_path(path) {
        return Err(format!(
            "端末（MTP）上のファイルは直接コピー/移動できません。取り出し（ダウンロード）を使ってください: {}",
            path
        ));
    }
    if !Path::new(path).is_absolute() {
        return Err(format!("絶対パスを指定してください: {}", path));
    }
    Ok(())
}

/// コピー（およびボリューム跨ぎの移動）で実際に作る中身の一覧。
struct CopyPlan {
    /// 作成するディレクトリ。中身が空のフォルダも移送するために要る。
    dirs: Vec<PathBuf>,
    /// コピーする (元, 先) のファイル対。
    files: Vec<(PathBuf, PathBuf)>,
}

/// Collect all directories and (src, dest) file pairs for a copy operation.
///
/// `dest` は「新しい名前まで含んだ移送先」。中身は src からの相対位置を
/// そのまま dest 配下に写す。
///
/// 以前は src の親を基準に相対パスを作り、dest の親に繋ぎ直していた。これは
/// src と dest の名前が同じ前提でしか成り立たず、名前衝突の「別名にする」で
/// フォルダを移送したとき（例: `photos` → `photos (1)`）、中身が元の名前の
/// フォルダへ書き込まれて、避けたはずの既存フォルダに混ざっていた。
///
/// また、ファイルだけを集めるとコピー先の親は create_dir_all で作られる一方、
/// 中身が空のフォルダはどこにも現れず消えてしまう。ディレクトリも別に
/// 集めておき、コピーの前に作る。
fn collect_copy_plan(src: &Path, dest: &Path) -> std::io::Result<CopyPlan> {
    let mut plan = CopyPlan {
        dirs: Vec::new(),
        files: Vec::new(),
    };
    if src.is_file() {
        plan.files.push((src.to_path_buf(), dest.to_path_buf()));
    } else if src.is_dir() {
        for entry in JWalkDir::new(src)
            .skip_hidden(false)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let ft = entry.file_type();
            // シンボリックリンクは辿らない（ループと意図しない実体化を避ける）。
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            // src 自身は rel が空になり、dest.join("") == dest になる。
            let rel = path.strip_prefix(src).unwrap_or(&path).to_path_buf();
            if ft.is_dir() {
                plan.dirs.push(dest.join(rel));
            } else if ft.is_file() {
                plan.files.push((path.clone(), dest.join(rel)));
            }
        }
    }
    Ok(plan)
}

// ファイル/ディレクトリのコピー（進捗イベント付き）
//
// 非同期コマンドにしたうえで実処理を spawn_blocking へ逃がしている。
// 同期コマンドは Tauri のメインスレッドで実行されるため、大量ファイルの
// コピー中はウィンドウ全体（描画・入力）が固まってしまう。
#[tauri::command]
pub async fn copy_item(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, CancelState>,
    src: String,
    dest: String,
    overwrite: bool,
) -> Result<(), String> {
    validate_path(&src)?;
    validate_path(&dest)?;
    let guard = cancel.begin();
    let flag = guard.flag();
    tokio::task::spawn_blocking(move || copy_item_blocking(&app, &flag, &src, &dest, overwrite))
        .await
        .map_err(|e| e.to_string())?
}

/// copy_item の実処理（ブロッキングスレッド上で実行される）。
fn copy_item_blocking(
    app: &tauri::AppHandle,
    flag: &Arc<AtomicBool>,
    src: &str,
    dest: &str,
    overwrite: bool,
) -> Result<(), String> {
    let src_path = Path::new(src);
    let dest_path = Path::new(dest);

    if !overwrite && dest_path.exists() {
        return Err(format!("コピー先がすでに存在します: {}", dest));
    }

    let plan = collect_copy_plan(src_path, dest_path).map_err(|e| e.to_string())?;
    copy_plan_with_progress(app, flag, &plan, "copy-progress")
}

/// 収集済みの計画を、進捗イベントを流しながら転送する。
///
/// コピーとボリューム跨ぎの移動で共通。イベント名だけを引数にしているのは、
/// 進捗オーバーレイに「コピー中」「移動中」を出し分けるため。
fn copy_plan_with_progress(
    app: &tauri::AppHandle,
    flag: &Arc<AtomicBool>,
    plan: &CopyPlan,
    event: &str,
) -> Result<(), String> {
    // 空のフォルダも残すため、先に階層を作っておく。
    for dir in &plan.dirs {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let total = plan.files.len();

    // Pre-calculate total bytes for progress reporting
    let bytes_total: u64 = plan.files.iter()
        .map(|(src_file, _)| std::fs::metadata(src_file).map(|m| m.len()).unwrap_or(0))
        .sum();
    let mut bytes_done: u64 = 0;
    // 直前の emit 時刻。PROGRESS_INTERVAL 未満の進捗通知は間引く。
    let mut last_emit: Option<Instant> = None;

    for (i, (src_file, dest_file)) in plan.files.iter().enumerate() {
        if flag.load(Ordering::Relaxed) {
            return Err("キャンセルされました".to_string());
        }
        if last_emit.map_or(true, |t| t.elapsed() >= PROGRESS_INTERVAL) {
            last_emit = Some(Instant::now());
            let file_name = src_file.file_name().unwrap_or_default().to_string_lossy().to_string();
            let _ = app.emit(event, ProgressPayload {
                current: i,
                total,
                file: file_name,
                done: false,
                bytes_done,
                bytes_total,
            });
        }
        if let Some(parent) = dest_file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let copied = std::fs::copy(src_file, dest_file).map_err(|e| e.to_string())?;
        bytes_done += copied;
    }

    let _ = app.emit(event, ProgressPayload {
        current: total,
        total,
        file: String::new(),
        done: true,
        bytes_done,
        bytes_total,
    });
    Ok(())
}

// ファイル/ディレクトリの移動
// ボリューム跨ぎの移動はコピー＋削除になり時間がかかるため、コピーと同様に
// メインスレッドをブロックしないバックグラウンド実行にし、進捗も流す。
#[tauri::command]
pub async fn move_item(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, CancelState>,
    src: String,
    dest: String,
    overwrite: bool,
) -> Result<(), String> {
    validate_path(&src)?;
    validate_path(&dest)?;
    let guard = cancel.begin();
    let flag = guard.flag();
    tokio::task::spawn_blocking(move || move_item_blocking(&app, &flag, &src, &dest, overwrite))
        .await
        .map_err(|e| e.to_string())?
}

/// move_item の実処理（ブロッキングスレッド上で実行される）。
fn move_item_blocking(
    app: &tauri::AppHandle,
    flag: &Arc<AtomicBool>,
    src: &str,
    dest: &str,
    overwrite: bool,
) -> Result<(), String> {
    let src_path = Path::new(src);
    let dest_path = Path::new(dest);

    if !overwrite && dest_path.exists() {
        return Err(format!("移動先がすでに存在します: {}", dest));
    }

    // 同一ボリューム内なら rename で一瞬なので、進捗は出さない。
    match std::fs::rename(src_path, dest_path) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() != std::io::ErrorKind::CrossesDevices => return Err(e.to_string()),
        Err(_) => {}
    }

    // 異なるデバイス間はコピー＋削除。件数とサイズに比例して時間がかかるので、
    // コピーと同じ進捗イベントを流す（名前だけ move-progress にする）。
    let plan = collect_copy_plan(src_path, dest_path).map_err(|e| e.to_string())?;
    copy_plan_with_progress(app, flag, &plan, "move-progress")?;

    // 元を消すのはコピーが最後まで通ってから。途中でキャンセル・失敗した場合は
    // ここに来ないので、まだ運べていないファイルが消えることはない
    // （コピー先には途中まで書かれたものが残る。これはコピーと同じ挙動）。
    if src_path.is_dir() {
        std::fs::remove_dir_all(src_path).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(src_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ファイル/ディレクトリの削除
// フォルダの再帰削除・ゴミ箱移動は件数に比例して時間がかかるためバックグラウンド実行。
#[tauri::command(async)]
pub fn delete_item(path: String, trash: bool) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);

    if trash {
        // Windows は trash クレートを使わない。あちらは IFileOperation のエラーを
        // すべて「中断された」に潰してしまい（詳細は windows_trash.rs）、フォルダ
        // 削除の失敗理由がユーザーにも我々にも分からなかった。
        #[cfg(windows)]
        {
            return crate::windows_trash::move_to_trash(p).map_err(|e| e.to_string());
        }
        #[cfg(not(windows))]
        {
            return ::trash::delete(p).map_err(|e| e.to_string());
        }
    }

    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// シンボリックリンクを作成する
#[tauri::command(async)]
pub fn create_symlink(src: String, link: String) -> Result<(), String> {
    validate_path(&src)?;
    validate_path(&link)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&src, &link).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        let src_path = std::path::Path::new(&src);
        if src_path.is_dir() {
            std::os::windows::fs::symlink_dir(&src, &link).map_err(|e| e.to_string())
        } else {
            std::os::windows::fs::symlink_file(&src, &link).map_err(|e| e.to_string())
        }
    }
}

/// ゴミ箱を空にする。プラットフォーム差分（macOS は trash クレートの os_limited が
/// 使えないため ~/.Trash を直接操作する）は trash_commands 側に集約している。
#[tauri::command(async)]
pub fn empty_trash() -> Result<usize, String> {
    crate::trash_commands::empty_trash_impl()
}

// リネーム
#[tauri::command(async)]
pub fn rename_item(src: String, new_name: String) -> Result<String, String> {
    validate_path(&src)?;
    // Reject names containing path separators or traversal sequences
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return Err("ファイル名にパス区切り文字または'..'は使用できません".to_string());
    }
    // Reject null bytes
    if new_name.contains('\0') {
        return Err("ファイル名にNULLバイトは使用できません".to_string());
    }
    // Reject Windows reserved device names (CON, NUL, COM1, LPT1, etc.)
    #[cfg(windows)]
    {
        const RESERVED: &[&str] = &[
            "CON", "PRN", "AUX", "NUL",
            "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        let upper = new_name.to_uppercase();
        let stem = upper.split('.').next().unwrap_or(upper.as_str());
        if RESERVED.contains(&stem) {
            return Err(format!(
                "Windowsの予約デバイス名は使用できません: {}",
                new_name
            ));
        }
    }
    let src_path = Path::new(&src);
    let parent = src_path
        .parent()
        .ok_or("親ディレクトリが取得できません")?;
    let dest_path = parent.join(&new_name);

    if dest_path.exists() {
        return Err(format!("同名のファイルがすでに存在します: {}", new_name));
    }

    std::fs::rename(src_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(dest_path.to_string_lossy().to_string())
}

// ディレクトリの作成
#[tauri::command(async)]
pub fn create_dir(path: String) -> Result<(), String> {
    validate_path(&path)?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

// ファイルの作成（空ファイル）
#[tauri::command(async)]
pub fn create_file(path: String) -> Result<(), String> {
    validate_path(&path)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("すでに存在します: {}", path)
            } else {
                e.to_string()
            }
        })
}

// ファイルの存在確認
#[tauri::command(async)]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 複数パスの存在確認を 1 回の呼び出しでまとめて行う。
/// 貼り付け前の衝突チェックは対象件数ぶんの往復が発生し、件数が多いと
/// 貼り付け開始までに固まったように見えるため、一括版を用意している。
/// 戻り値は入力と同じ順序・同じ長さ。
#[tauri::command(async)]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).exists()).collect()
}

/// 既存パスと衝突しない名前を "name (2).ext" 形式で作る。
/// 空きが見つからなければ元のパスをそのまま返す。
#[tauri::command(async)]
pub fn unique_dest_path(path: String) -> String {
    if !Path::new(&path).exists() {
        return path;
    }
    let sep = if path.contains('\\') { '\\' } else { '/' };
    let last_sep = path.rfind(['\\', '/']);
    let (dir, name) = match last_sep {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path.as_str()),
    };
    // 先頭のドット（ドットファイル）は拡張子扱いしない
    let dot = name.rfind('.').filter(|i| *i > 0);
    let (base, ext) = match dot {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    for i in 2..1000 {
        let candidate = format!("{}{}{} ({}){}", dir, sep, base, i, ext);
        if !Path::new(&candidate).exists() {
            return candidate;
        }
    }
    path
}

fn templates_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE")
        .map_err(|_| "USERPROFILE が見つかりません".to_string())?;
    #[cfg(not(windows))]
    let home = std::env::var("HOME")
        .map_err(|_| "HOME が見つかりません".to_string())?;
    Ok(PathBuf::from(home).join(".shirube-filer").join("templates"))
}

/// Return the filenames inside ~/.shirube-filer/templates/.
/// Returns an empty list if the directory does not exist.
#[tauri::command(async)]
pub fn list_templates() -> Result<Vec<String>, String> {
    let dir = templates_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if entry.path().is_file() {
                entry.file_name().into_string().ok()
            } else {
                None
            }
        })
        .collect();
    names.sort();
    Ok(names)
}

/// Create a new file at `target` by copying the named template.
#[tauri::command(async)]
pub fn create_file_from_template(target: String, template_name: String) -> Result<(), String> {
    validate_path(&target)?;
    // Prevent path traversal in the template name
    if template_name.contains('/') || template_name.contains('\\') || template_name.contains("..") {
        return Err("テンプレート名が不正です".to_string());
    }
    let template_path = templates_dir()?.join(&template_name);
    if !template_path.exists() {
        return Err(format!("テンプレートが見つかりません: {}", template_name));
    }
    let content = std::fs::read(&template_path).map_err(|e| e.to_string())?;
    std::fs::write(&target, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::collect_copy_plan;
    use std::path::{Path, PathBuf};

    /// テスト用の一時ディレクトリ。外部クレートを足さずに済ませるため自前で用意する。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "shirube-copyplan-{tag}-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).expect("create temp dir");
            TempDir(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 中身が空のフォルダも計画に含める。
    /// ファイルだけを集めていた頃は、コピー先の親が create_dir_all で作られる
    /// 一方で空フォルダはどこにも現れず、コピー／移動のたびに消えていた。
    #[test]
    fn collect_copy_plan_keeps_empty_directories() {
        let tmp = TempDir::new("empty");
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("empty_child")).unwrap();
        std::fs::create_dir_all(src.join("with_file")).unwrap();
        std::fs::write(src.join("with_file").join("a.txt"), b"a").unwrap();

        let dest = tmp.path().join("dest");
        let plan = collect_copy_plan(&src, &dest).unwrap();

        assert!(
            plan.dirs.contains(&dest.join("empty_child")),
            "空フォルダが計画に含まれていない: {:?}",
            plan.dirs
        );
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].1, dest.join("with_file").join("a.txt"));
    }

    /// 名前衝突を「別名にする」で解決したとき、中身も新しい名前の下に入る。
    /// 以前は src の親を基準にしていたため元の名前のフォルダへ書き込まれ、
    /// 避けたはずの既存フォルダに混ざっていた。
    #[test]
    fn collect_copy_plan_follows_a_renamed_destination() {
        let tmp = TempDir::new("renamed");
        let src = tmp.path().join("photos");
        std::fs::create_dir_all(src.join("2026")).unwrap();
        std::fs::write(src.join("2026").join("a.jpg"), b"a").unwrap();

        // 衝突回避で別名になった移送先。
        let dest = tmp.path().join("out").join("photos (1)");
        let plan = collect_copy_plan(&src, &dest).unwrap();

        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].1, dest.join("2026").join("a.jpg"));
        assert!(plan.dirs.contains(&dest), "移送先そのものが作られない");
        assert!(
            plan.files.iter().all(|(_, d)| d.starts_with(&dest)),
            "移送先の外へ書き込む計画になっている: {:?}",
            plan.files
        );
    }

    /// 単一ファイルは指定された移動先そのものに対応づける（親を足さない）。
    #[test]
    fn collect_copy_plan_maps_a_single_file_to_dest() {
        let tmp = TempDir::new("single");
        let src = tmp.path().join("a.txt");
        std::fs::write(&src, b"a").unwrap();
        let dest = tmp.path().join("b.txt");

        let plan = collect_copy_plan(&src, &dest).unwrap();

        assert!(plan.dirs.is_empty());
        assert_eq!(plan.files, vec![(src, dest)]);
    }
}
