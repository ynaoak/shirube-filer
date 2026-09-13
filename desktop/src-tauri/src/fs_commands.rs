use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use std::time::UNIX_EPOCH;
use jwalk::WalkDir as JWalkDir;

/// キャンセルされた走査が返すエラー。フロントはこれを「失敗」ではなく
/// 「破棄された結果」として扱う（トーストを出さない）。
pub const SCAN_CANCELLED: &str = "走査をキャンセルしました";

/// 長時間かかる走査（フォルダサイズ計算・再帰検索・grep・ディスク使用量）の
/// キャンセル状態。
///
/// これらは 1 フォルダに何十個も同時に投げられる（例: 一覧のフォルダサイズ計算は
/// フォルダの数だけ get_dir_size を並行実行する）。中断できないと、別パスへ
/// 移動しても裏で走り続けてディスク I/O とスレッドを占有し、移動先の読み込みが
/// いつまでも始まらない。
///
/// フロントは「どこから始めた走査か」を表すトークン（ペイン ID + 連番など）を
/// 渡し、移動・キャンセル時に cancel_scan(token) でまとめて止める。
#[derive(Default, Clone)]
pub struct ScanState {
    inner: Arc<ScanStateInner>,
}

#[derive(Default)]
struct ScanStateInner {
    /// token → [(登録 ID, キャンセルフラグ)]
    map: Mutex<HashMap<String, Vec<(u64, Arc<AtomicBool>)>>>,
    next_id: AtomicU64,
}

/// 走査 1 件の登録。drop 時に自動で登録解除する。
pub struct ScanGuard {
    state: ScanState,
    entry: Option<(String, u64)>,
    flag: Arc<AtomicBool>,
}

impl ScanGuard {
    /// キャンセル済みなら true。走査ループの中で定期的に確認する。
    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        let Some((token, id)) = self.entry.take() else { return };
        let mut map = match self.state.inner.map.lock() {
            Ok(g) => g,
            // poison しても以降の走査が登録できなくならないよう継続する
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(list) = map.get_mut(&token) {
            list.retain(|(entry_id, _)| *entry_id != id);
            if list.is_empty() {
                map.remove(&token);
            }
        }
    }
}

impl ScanState {
    /// 走査を登録してガードを返す。token が None の場合はキャンセル対象にならない
    /// （トークンを渡さない既存の呼び出しはこれまでどおり動く）。
    pub fn begin(&self, token: Option<String>) -> ScanGuard {
        let flag = Arc::new(AtomicBool::new(false));
        let entry = token.map(|token| {
            let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
            let mut map = match self.inner.map.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            map.entry(token.clone()).or_default().push((id, flag.clone()));
            (token, id)
        });
        ScanGuard {
            state: self.clone(),
            entry,
            flag,
        }
    }

    fn cancel(&self, token: &str) {
        let map = match self.inner.map.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(list) = map.get(token) {
            for (_, flag) in list {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

/// 指定トークンで開始された走査をすべて中断する。
/// 走っていなければ何もしない（呼び出し側は結果を待たなくてよい）。
#[tauri::command]
pub fn cancel_scan(state: tauri::State<'_, ScanState>, token: String) {
    state.cancel(&token);
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("パスにNULLバイトは使用できません".to_string());
    }
    if !Path::new(path).is_absolute() {
        return Err(format!("絶対パスを指定してください: {}", path));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub extension: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub readonly: bool,
    pub size: u64,
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub accessed: Option<u64>,
    pub symlink_target: Option<String>,
    /// Unix permissions string e.g. "rwxr-xr-x" (None on Windows)
    pub permissions: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirResult {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

// ディレクトリ一覧の取得。
//
// 実処理は spawn_blocking へ逃がす。`#[tauri::command(async)]` の同期関数は
// tokio のワーカースレッド上で走るため、応答しないパス（macOS のネットワーク
// ボリューム、スリープ中の外付けディスク、TCC の許可ダイアログ待ちなど）で
// read_dir がブロックすると、ワーカーを 1 本ずつ食い潰す。ワーカーが尽きると
// 後続の IPC コマンドが一切処理されなくなり、「移動をやめて別パスへ行く」ことも
// できなくなる。ブロッキング専用プールなら他のコマンドを巻き込まない。
#[tauri::command]
pub async fn read_dir(path: String) -> Result<ReadDirResult, String> {
    tokio::task::spawn_blocking(move || read_dir_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_dir_blocking(path: String) -> Result<ReadDirResult, String> {
    // MTP（スマホ等ポータブルデバイス）の仮想パスは WPD 経由で列挙する。
    if crate::mtp_commands::is_mtp_path(&path) {
        return crate::mtp_commands::read_dir(&path);
    }
    let dir_path = if path.is_empty() {
        home_dir().ok_or("Could not determine home directory")?
    } else {
        PathBuf::from(&path)
    };

    // ディレクトリエントリをまず収集（イテレータはシリアルで消費する必要がある）
    let raw_entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&dir_path)
        .map_err(|e| e.to_string())?
        .filter_map(|res| res.ok())
        .collect();

    // メタデータ取得を rayon で並列化（syscall を並列実行）
    let entries: Vec<FileEntry> = raw_entries
        .into_par_iter()
        .map(|entry| {
            let metadata = entry.metadata().ok();
            let file_type = entry.file_type().ok();
            let is_dir = file_type.as_ref().map(|t| t.is_dir()).unwrap_or(false);
            let is_symlink = file_type.as_ref().map(|t| t.is_symlink()).unwrap_or(false);
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified = metadata.as_ref().and_then(|m| {
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
            });
            let name = entry.file_name().to_string_lossy().to_string();
            let extension = Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_string());
            let is_hidden = is_hidden_entry(&name, &entry);

            FileEntry {
                path: entry.path().to_string_lossy().to_string(),
                name,
                is_dir,
                is_symlink,
                is_hidden,
                size,
                modified,
                extension,
            }
        })
        .collect();

    // ディレクトリ優先でソート
    let mut entries = entries;
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(ReadDirResult {
        path: dir_path.to_string_lossy().to_string(),
        entries,
    })
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or("Could not determine home directory".to_string())
}

#[tauri::command]
pub fn get_parent_dir(path: String) -> Option<String> {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
}

/// Determine whether a directory entry should be considered hidden.
fn is_hidden_entry(name: &str, entry: &std::fs::DirEntry) -> bool {
    // Unix: any file whose name starts with '.'
    #[cfg(not(windows))]
    {
        let _ = entry;
        name.starts_with('.')
    }
    // Windows: FILE_ATTRIBUTE_HIDDEN (0x2)
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(meta) = entry.metadata() {
            const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
            meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
        } else {
            name.starts_with('.')
        }
    }
}

#[tauri::command(async)]
pub fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let p = Path::new(&path);
    // Use symlink_metadata so we report on the link itself, not its target.
    let meta = std::fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    let file_type = meta.file_type();

    let ts = |t: std::io::Result<std::time::SystemTime>| -> Option<u64> {
        t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
    };

    let symlink_target = if file_type.is_symlink() {
        std::fs::read_link(p)
            .ok()
            .map(|t| t.to_string_lossy().to_string())
    } else {
        None
    };

    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        Some(unix_mode_string(mode))
    };
    #[cfg(not(unix))]
    let permissions: Option<String> = None;

    let is_hidden = {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
            meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
        }
        #[cfg(not(windows))]
        {
            name.starts_with('.')
        }
    };

    Ok(FileMetadata {
        path: p.to_string_lossy().to_string(),
        name,
        is_dir: file_type.is_dir(),
        is_symlink: file_type.is_symlink(),
        is_hidden,
        readonly: meta.permissions().readonly(),
        size: meta.len(),
        created: ts(meta.created()),
        modified: ts(meta.modified()),
        accessed: ts(meta.accessed()),
        symlink_target,
        permissions,
    })
}

#[cfg(unix)]
fn unix_mode_string(mode: u32) -> String {
    let bits = [
        (0o400, 'r'), (0o200, 'w'), (0o100, 'x'),
        (0o040, 'r'), (0o020, 'w'), (0o010, 'x'),
        (0o004, 'r'), (0o002, 'w'), (0o001, 'x'),
    ];
    bits.iter()
        .map(|(mask, c)| if mode & mask != 0 { *c } else { '-' })
        .collect()
}

const SEARCH_EXCLUDE_DIRS: &[&str] = &["node_modules", ".git", "target", ".cache", "__pycache__"];

#[tauri::command]
pub async fn search_files(
    state: tauri::State<'_, ScanState>,
    root: String,
    query: String,
    max_results: usize,
    scan_token: Option<String>,
) -> Result<Vec<FileEntry>, String> {
    validate_path(&root)?;
    let scans = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        search_files_blocking(&scans, scan_token, root, query, max_results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn search_files_blocking(
    scans: &ScanState,
    scan_token: Option<String>,
    root: String,
    query: String,
    max_results: usize,
) -> Result<Vec<FileEntry>, String> {
    let guard = scans.begin(scan_token);
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let max = if max_results == 0 { 200 } else { max_results };
    let mut results = Vec::new();

    let walker = JWalkDir::new(&root)
        .skip_hidden(false)
        .follow_links(false)
        .process_read_dir(|_depth, _path, _state, children| {
            children.retain(|res| {
                res.as_ref()
                    .map(|e| {
                        if e.file_type().is_dir() {
                            let name = e.file_name.to_string_lossy();
                            !SEARCH_EXCLUDE_DIRS.contains(&&*name)
                        } else {
                            true
                        }
                    })
                    .unwrap_or(true)
            });
        });
    for entry in walker {
        if results.len() >= max {
            break;
        }
        if guard.cancelled() {
            return Err(SCAN_CANCELLED.to_string());
        }
        let e = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        // Skip the root itself
        if e.depth() == 0 {
            continue;
        }
        let name = e.file_name.to_string_lossy().to_string();
        if !name.to_lowercase().contains(&q) {
            continue;
        }
        let path_str = e.path().to_string_lossy().to_string();
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let extension = e.path().extension().map(|x| x.to_string_lossy().to_string());
        let is_hidden = {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
                meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
            }
            #[cfg(not(windows))]
            {
                name.starts_with('.')
            }
        };
        results.push(FileEntry {
            name,
            path: path_str,
            is_dir: meta.is_dir(),
            is_symlink: meta.is_symlink(),
            is_hidden,
            size: if meta.is_file() { meta.len() } else { 0 },
            modified,
            extension,
        });
    }

    Ok(results)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub path: String,
    pub line_number: usize,
    pub line: String,
}

#[tauri::command]
pub async fn grep_files(
    state: tauri::State<'_, ScanState>,
    root: String,
    pattern: String,
    max_results: usize,
    scan_token: Option<String>,
) -> Result<Vec<GrepMatch>, String> {
    validate_path(&root)?;
    let scans = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        grep_files_blocking(&scans, scan_token, root, pattern, max_results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn grep_files_blocking(
    scans: &ScanState,
    scan_token: Option<String>,
    root: String,
    pattern: String,
    max_results: usize,
) -> Result<Vec<GrepMatch>, String> {
    use std::io::{BufRead, BufReader};
    let guard = scans.begin(scan_token);

    let pat = pattern.trim().to_lowercase();
    if pat.is_empty() {
        return Ok(vec![]);
    }
    let max = if max_results == 0 { 200 } else { max_results };
    let mut results = Vec::new();

    // Text file extensions to search
    const TEXT_EXTS: &[&str] = &[
        "txt", "md", "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "c", "cpp", "h",
        "css", "scss", "html", "json", "yaml", "yml", "toml", "sh", "bat", "ini", "conf",
        "xml", "svg", "vue", "rb", "php", "swift", "kt", "cs",
    ];

    // Phase 1: collect candidate text files (jwalk-parallel enumeration).
    let mut files: Vec<PathBuf> = Vec::new();
    let walker = JWalkDir::new(&root)
        .skip_hidden(false)
        .follow_links(false)
        .process_read_dir(|_depth, _path, _state, children| {
            children.retain(|res| {
                res.as_ref()
                    .map(|e| {
                        if e.file_type().is_dir() {
                            let name = e.file_name.to_string_lossy();
                            !SEARCH_EXCLUDE_DIRS.contains(&&*name)
                        } else {
                            true
                        }
                    })
                    .unwrap_or(true)
            });
        });
    for entry in walker.into_iter().flatten() {
        if guard.cancelled() {
            return Err(SCAN_CANCELLED.to_string());
        }
        if entry.file_type().is_dir() || entry.depth() == 0 {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().map(|x| x.to_string_lossy().to_lowercase());
        if !TEXT_EXTS.contains(&ext.as_deref().unwrap_or("")) {
            continue;
        }
        // Skip large files (>1MB)
        if let Ok(m) = entry.metadata() {
            if m.len() > 1_000_000 {
                continue;
            }
        }
        files.push(path);
    }

    // Phase 2: grep each file in parallel; file order is preserved in output.
    let per_file: Vec<Vec<GrepMatch>> = files
        .par_iter()
        .map(|path| {
            let mut local = Vec::new();
            if guard.cancelled() {
                return local;
            }
            if let Ok(file) = std::fs::File::open(path) {
                let reader = BufReader::new(file);
                for (i, line) in reader.lines().enumerate() {
                    let line = match line {
                        Ok(l) => l,
                        Err(_) => break,
                    };
                    if line.to_lowercase().contains(&pat) {
                        local.push(GrepMatch {
                            path: path.to_string_lossy().to_string(),
                            line_number: i + 1,
                            line: line.chars().take(200).collect(),
                        });
                    }
                }
            }
            local
        })
        .collect();

    if guard.cancelled() {
        return Err(SCAN_CANCELLED.to_string());
    }

    'outer: for matches in per_file {
        for m in matches {
            results.push(m);
            if results.len() >= max {
                break 'outer;
            }
        }
    }
    Ok(results)
}

/// Recursively sum file sizes under a directory. Skips symlinks and unreadable entries.
///
/// 一覧のフォルダサイズ表示はフォルダの数だけこのコマンドを同時に投げるため、
/// ブロッキングプールで実行し（tokio のワーカーを食い潰さない）、scan_token で
/// 中断できるようにしている。
#[tauri::command]
pub async fn get_dir_size(
    state: tauri::State<'_, ScanState>,
    path: String,
    scan_token: Option<String>,
) -> Result<u64, String> {
    validate_path(&path)?;
    let scans = state.inner().clone();
    tokio::task::spawn_blocking(move || get_dir_size_blocking(&scans, scan_token, path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_dir_size_blocking(
    scans: &ScanState,
    scan_token: Option<String>,
    path: String,
) -> Result<u64, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("ディレクトリではありません: {}", path));
    }
    let guard = scans.begin(scan_token);
    let mut total: u64 = 0;
    for entry in JWalkDir::new(root)
        .skip_hidden(false)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if guard.cancelled() {
            return Err(SCAN_CANCELLED.to_string());
        }
        if entry.file_type().is_file() {
            total = total.saturating_add(entry.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }
    Ok(total)
}

/// List immediate children of a directory with their total sizes (for treemap).
#[derive(Serialize)]
pub struct DiskEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn get_disk_usage(
    state: tauri::State<'_, ScanState>,
    path: String,
    scan_token: Option<String>,
) -> Result<Vec<DiskEntry>, String> {
    validate_path(&path)?;
    let scans = state.inner().clone();
    tokio::task::spawn_blocking(move || get_disk_usage_blocking(&scans, scan_token, path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_disk_usage_blocking(
    scans: &ScanState,
    scan_token: Option<String>,
    path: String,
) -> Result<Vec<DiskEntry>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err(format!("ディレクトリではありません: {path}"));
    }
    let guard = scans.begin(scan_token);
    let read = std::fs::read_dir(dir_path).map_err(|e| e.to_string())?;
    let mut entries: Vec<DiskEntry> = Vec::new();
    for entry in read.flatten() {
        if guard.cancelled() {
            return Err(SCAN_CANCELLED.to_string());
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let size = if is_dir {
            let mut sum: u64 = 0;
            for e in JWalkDir::new(entry.path())
                .skip_hidden(false)
                .follow_links(false)
                .into_iter()
                .flatten()
            {
                if guard.cancelled() {
                    return Err(SCAN_CANCELLED.to_string());
                }
                if e.file_type().is_file() {
                    sum = sum.saturating_add(e.metadata().map(|m| m.len()).unwrap_or(0));
                }
            }
            sum
        } else {
            meta.len()
        };
        entries.push(DiskEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            size,
            is_dir,
        });
    }
    entries.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(entries)
}

/// Compare two directories recursively by name + size.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareDirEntry {
    pub relative_path: String,
    pub status: String, // "identical" | "modified" | "left_only" | "right_only"
    pub left_size: Option<u64>,
    pub right_size: Option<u64>,
    pub left_modified: Option<u64>,
    pub right_modified: Option<u64>,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn compare_dirs(
    window: tauri::Window,
    left: String,
    right: String,
) -> Result<Vec<CompareDirEntry>, String> {
    validate_path(&left)?;
    validate_path(&right)?;

    let left_clone = left.clone();
    let right_clone = right.clone();

    // Scan both directories in parallel on the blocking thread pool
    let (left_map, right_map) = tokio::task::spawn_blocking(move || {
        use std::collections::HashMap;

        fn collect(base: &Path) -> HashMap<String, (u64, u64, bool)> {
            let mut map = HashMap::new();
            let walker = JWalkDir::new(base).skip_hidden(false).follow_links(false).into_iter();
            for entry in walker.filter_map(|e| e.ok()) {
                if let Ok(meta) = entry.metadata() {
                    let rel = entry.path()
                        .strip_prefix(base)
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    if rel.is_empty() { continue; }
                    let mtime = meta.modified().ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let is_dir = meta.is_dir();
                    let size = if is_dir { 0 } else { meta.len() };
                    map.insert(rel, (size, mtime, is_dir));
                }
            }
            map
        }

        rayon::join(
            || collect(Path::new(&left_clone)),
            || collect(Path::new(&right_clone)),
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut all_keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    all_keys.extend(left_map.keys().cloned());
    all_keys.extend(right_map.keys().cloned());

    let total = all_keys.len();
    let mut results = Vec::with_capacity(total);
    let mut done = 0usize;

    for key in all_keys {
        let l = left_map.get(&key);
        let r = right_map.get(&key);
        let status = match (l, r) {
            (Some(l), Some(r)) => if l.0 == r.0 && l.1 == r.1 { "identical" } else { "modified" },
            (Some(_), None) => "left_only",
            (None, Some(_)) => "right_only",
            (None, None) => continue,
        };
        results.push(CompareDirEntry {
            relative_path: key,
            status: status.to_string(),
            left_size: l.map(|v| v.0),
            right_size: r.map(|v| v.0),
            left_modified: l.map(|v| v.1),
            right_modified: r.map(|v| v.1),
            is_dir: l.map(|v| v.2).or_else(|| r.map(|v| v.2)).unwrap_or(false),
        });
        done += 1;
        // Emit progress every 500 entries
        if done % 500 == 0 {
            let _ = window.emit("compare-progress", serde_json::json!({ "done": done, "total": total }));
        }
    }
    Ok(results)
}

/// Set or clear the read-only flag on a file/directory.
#[tauri::command(async)]
pub fn set_file_readonly(path: String, readonly: bool) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let mut perms = meta.permissions();
    perms.set_readonly(readonly);
    std::fs::set_permissions(p, perms).map_err(|e| e.to_string())
}

/// Toggle FILE_ATTRIBUTE_HIDDEN on Windows. No-op on non-Windows.
/// attrib コマンドの終了を待つためバックグラウンド実行にする。
#[tauri::command(async)]
pub fn set_file_hidden(path: String, hidden: bool) -> Result<(), String> {
    validate_path(&path)?;
    #[cfg(windows)]
    {
        let flag = if hidden { "+H" } else { "-H" };
        let status = std::process::Command::new("attrib")
            .arg(flag)
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("attrib コマンドが失敗しました ({})", path));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (path, hidden); // hidden attribute not applicable on Unix
    }
    Ok(())
}

/// Calculate MD5 and SHA256 checksums for a file.
#[tauri::command(async)]
pub fn get_checksum(path: String) -> Result<(String, String), String> {
    validate_path(&path)?;
    use md5::{Md5, Digest as _};
    use sha2::Sha256;
    use std::io::Read;

    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut md5 = Md5::new();
    let mut sha256 = Sha256::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        md5.update(&buf[..n]);
        sha256.update(&buf[..n]);
    }
    let md5_hex = format!("{:x}", md5.finalize());
    let sha256_hex = format!("{:x}", sha256.finalize());
    Ok((md5_hex, sha256_hex))
}

/// Find duplicate files in given directories by size then MD5 hash.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub hash: String,
    pub size: u64,
    pub paths: Vec<String>,
}

#[tauri::command(async)]
pub fn find_duplicates(dirs: Vec<String>) -> Result<Vec<DuplicateGroup>, String> {
    for dir in &dirs { validate_path(dir)?; }
    use md5::{Md5, Digest as Md5Digest};
    use std::collections::HashMap;
    use std::io::Read;

    // Collect all files with their sizes
    let mut size_map: HashMap<u64, Vec<String>> = HashMap::new();
    for dir in &dirs {
        for entry in JWalkDir::new(dir).skip_hidden(false).follow_links(false).into_iter().flatten() {
            if !entry.file_type().is_file() { continue; }
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            let size = meta.len();
            if size == 0 { continue; }
            size_map.entry(size).or_default().push(entry.path().to_string_lossy().into_owned());
        }
    }

    // For sizes with multiple files, compute MD5 hash
    let mut hash_map: HashMap<String, Vec<String>> = HashMap::new();
    for (size, paths) in size_map {
        if paths.len() < 2 { continue; }
        for path in paths {
            let hash = (|| -> Option<String> {
                let mut file = std::fs::File::open(&path).ok()?;
                let mut hasher = Md5::new();
                let mut buf = vec![0u8; 65536];
                loop {
                    let n = file.read(&mut buf).ok()?;
                    if n == 0 { break; }
                    hasher.update(&buf[..n]);
                }
                let key = format!("{size}:{:x}", hasher.finalize());
                Some(key)
            })();
            if let Some(h) = hash {
                hash_map.entry(h).or_default().push(path);
            }
        }
    }

    let mut groups: Vec<DuplicateGroup> = hash_map
        .into_iter()
        .filter(|(_, paths)| paths.len() >= 2)
        .map(|(key, paths)| {
            let size: u64 = key.split(':').next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let hash = key.split(':').nth(1).unwrap_or("").to_string();
            DuplicateGroup { hash, size, paths }
        })
        .collect();
    groups.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(groups)
}

/// Information about a mounted drive / volume.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// Mount point path (e.g., "C:\\" on Windows, "/" on Unix)
    pub path: String,
    /// Volume label or name (e.g., "Windows", "Macintosh HD")
    pub label: String,
    /// Total capacity in bytes (0 if unavailable)
    pub total_bytes: u64,
    /// Free / available bytes (0 if unavailable)
    pub free_bytes: u64,
    /// "fixed" | "removable" | "unknown"
    pub kind: String,
}

#[tauri::command(async)]
pub fn list_volumes() -> Vec<VolumeInfo> {
    use sysinfo::{Disks, DiskKind};
    let disks = Disks::new_with_refreshed_list();
    let mut result: Vec<VolumeInfo> = disks
        .list()
        .iter()
        .map(|disk| {
            let kind = match disk.kind() {
                DiskKind::HDD | DiskKind::SSD => "fixed",
                DiskKind::Unknown(_) => "unknown",
            };
            let removable = if disk.is_removable() { "removable" } else { kind };
            let raw_label = disk.name().to_string_lossy().to_string();
            let mount = disk.mount_point().to_string_lossy().to_string();
            let label = if raw_label.is_empty() { mount.clone() } else { raw_label };
            VolumeInfo {
                path: mount,
                label,
                total_bytes: disk.total_space(),
                free_bytes: disk.available_space(),
                kind: removable.to_string(),
            }
        })
        .collect();
    // Sort: fixed drives first, then by path
    result.sort_by(|a, b| {
        let ak = if a.kind == "fixed" { 0 } else { 1 };
        let bk = if b.kind == "fixed" { 0 } else { 1 };
        ak.cmp(&bk).then(a.path.cmp(&b.path))
    });
    result
}

/// ドライブ（USB メモリ・外付け HDD・スマートフォン等）の抜き差しを OS
/// ネイティブのイベントで監視し、変化したらフロントへ `volumes-changed` を
/// 通知する。フロントはこれを受けてドライブ一覧を再取得し、接続直後の
/// デバイスへアクセスできるようにする。固定間隔ポーリングは行わない。
///
/// - Windows: `register_device_notifications`（ウィンドウの `WM_DEVICECHANGE`）
///   で処理するため、ここでは何もしない。
/// - macOS: `/Volumes` を FSEvents（notify）で監視。
/// - Linux: `/proc/self/mountinfo` を `poll()` でブロッキング待機。
#[allow(unused_variables)]
pub fn spawn_volume_watcher(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    watch_volumes_macos(app);
    #[cfg(target_os = "linux")]
    watch_volumes_linux(app);
    // Windows は register_device_notifications() 側で処理する。
}

#[cfg(target_os = "macos")]
fn watch_volumes_macos(app: tauri::AppHandle) {
    use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use tauri::Emitter;
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            notify::Config::default(),
        ) {
            Ok(w) => w,
            Err(_) => return,
        };
        // 外付けドライブは /Volumes 直下にマウントされる。作成/削除を監視。
        if watcher
            .watch(std::path::Path::new("/Volumes"), RecursiveMode::NonRecursive)
            .is_err()
        {
            return;
        }
        // watcher は for ループが rx を保持する間だけ生存させる。
        for res in rx {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Create(_) | EventKind::Remove(_)) {
                    let _ = app.emit("volumes-changed", ());
                }
            }
        }
    });
}

#[cfg(target_os = "linux")]
fn watch_volumes_linux(app: tauri::AppHandle) {
    use std::os::unix::io::AsRawFd;
    use tauri::Emitter;
    std::thread::spawn(move || loop {
        // mountinfo は poll() の POLLPRI でマウント表の変化を通知する。
        // 通知を受けたら再オープンして待機を張り直す（これで再武装される）。
        let file = match std::fs::File::open("/proc/self/mountinfo") {
            Ok(f) => f,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_secs(5));
                continue;
            }
        };
        let mut pfd = libc::pollfd {
            fd: file.as_raw_fd(),
            events: libc::POLLPRI | libc::POLLERR,
            revents: 0,
        };
        let r = unsafe { libc::poll(&mut pfd, 1, -1) };
        if r < 0 {
            // 割り込み等。短く待って張り直す。
            std::thread::sleep(std::time::Duration::from_millis(500));
            continue;
        }
        if pfd.revents & (libc::POLLPRI | libc::POLLERR) != 0 {
            // マウントが落ち着くのを待ってから通知をまとめる。
            std::thread::sleep(std::time::Duration::from_millis(300));
            let _ = app.emit("volumes-changed", ());
        }
    });
}

/// Windows: メインウィンドウをサブクラス化し、`WM_DEVICECHANGE`（デバイスの
/// 着脱ブロードキャスト）を受けて `volumes-changed` を発火する。ボリューム
/// (USB メモリ・外付け HDD 等) の着脱はトップレベルウィンドウへ既定で
/// ブロードキャストされるため、デバイス登録は不要。
#[cfg(windows)]
pub fn register_device_notifications(window: &tauri::WebviewWindow, app: tauri::AppHandle) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::SetWindowSubclass;

    let hwnd = match window.window_handle() {
        Ok(h) => match h.as_raw() {
            RawWindowHandle::Win32(w) => HWND(w.hwnd.get() as *mut _),
            _ => return,
        },
        Err(_) => return,
    };
    // AppHandle をヒープに確保し、サブクラスの参照データとして渡す
    // （アプリ寿命中は保持し続けるため意図的にリークさせる）。
    let boxed = Box::into_raw(Box::new(app)) as usize;
    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(device_subclass_proc), DEVICE_SUBCLASS_ID, boxed);
    }
}

#[cfg(windows)]
const DEVICE_SUBCLASS_ID: usize = 0x00D1_2CE0;

#[cfg(windows)]
unsafe extern "system" fn device_subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _uid_subclass: usize,
    dwrefdata: usize,
) -> windows::Win32::Foundation::LRESULT {
    use tauri::Emitter;
    use windows::Win32::UI::Shell::DefSubclassProc;

    const WM_DEVICECHANGE: u32 = 0x0219;
    const DBT_DEVICEARRIVAL: usize = 0x8000;
    const DBT_DEVICEREMOVECOMPLETE: usize = 0x8004;

    if msg == WM_DEVICECHANGE
        && (wparam.0 == DBT_DEVICEARRIVAL || wparam.0 == DBT_DEVICEREMOVECOMPLETE)
    {
        let app = &*(dwrefdata as *const tauri::AppHandle);
        let _ = app.emit("volumes-changed", ());
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// 指定アプリでファイルを開く
#[tauri::command(async)]
pub fn open_with_app(file_path: String, app_path: String) -> Result<(), String> {
    validate_path(&file_path)?;
    // Windows: .bat / .cmd は CreateProcess で直接起動できないため cmd /c を挟む。
    let lower = app_path.to_lowercase();
    let mut cmd = if cfg!(target_os = "windows") && (lower.ends_with(".bat") || lower.ends_with(".cmd")) {
        let mut c = std::process::Command::new("cmd");
        c.arg("/c").arg(&app_path);
        c
    } else {
        std::process::Command::new(&app_path)
    };
    cmd.arg(&file_path)
        .spawn()
        .map_err(|e| format!("起動失敗 ({}): {}", app_path, e))?;
    Ok(())
}
