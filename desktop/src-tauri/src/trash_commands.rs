use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct TrashEntry {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub deleted_at: i64,
    pub size: u64,
    pub is_dir: bool,
}

// ゴミ箱の列挙・復元・完全削除は件数に比例して時間がかかるためバックグラウンド実行。
#[tauri::command(async)]
pub fn list_trash_items() -> Result<Vec<TrashEntry>, String> {
    platform::list()
}

#[tauri::command(async)]
pub fn restore_trash_item(original_path: String) -> Result<(), String> {
    platform::restore(&original_path)
}

#[tauri::command(async)]
pub fn purge_trash_item(original_path: String) -> Result<(), String> {
    platform::purge(&original_path)
}

/// ゴミ箱を空にする（全プラットフォーム対応）。
pub fn empty_trash_impl() -> Result<usize, String> {
    platform::empty()
}

// ── Windows / Linux: trash クレートの os_limited をそのまま使う ─────────────
#[cfg(not(target_os = "macos"))]
mod platform {
    use super::TrashEntry;

    pub fn list() -> Result<Vec<TrashEntry>, String> {
        let items = ::trash::os_limited::list().map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for item in items {
            let path = item.original_path();
            let is_dir = path.is_dir();
            let size = if is_dir {
                0
            } else {
                std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            };
            entries.push(TrashEntry {
                id: format!("{:?}", item.id),
                name: item.name.to_string_lossy().into_owned(),
                original_path: path.to_string_lossy().into_owned(),
                deleted_at: item.time_deleted,
                size,
                is_dir,
            });
        }
        Ok(entries)
    }

    fn find(original_path: &str) -> Result<::trash::TrashItem, String> {
        ::trash::os_limited::list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|i| i.original_path().to_string_lossy() == original_path)
            .ok_or_else(|| format!("ゴミ箱にアイテムが見つかりません: {original_path}"))
    }

    pub fn restore(original_path: &str) -> Result<(), String> {
        let target = find(original_path)?;
        ::trash::os_limited::restore_all(std::iter::once(target)).map_err(|e| e.to_string())
    }

    pub fn purge(original_path: &str) -> Result<(), String> {
        let target = find(original_path)?;
        ::trash::os_limited::purge_all(std::iter::once(target)).map_err(|e| e.to_string())
    }

    pub fn empty() -> Result<usize, String> {
        let items = ::trash::os_limited::list().map_err(|e| e.to_string())?;
        let count = items.len();
        ::trash::os_limited::purge_all(items).map_err(|e| e.to_string())?;
        Ok(count)
    }
}

// ── macOS: ~/.Trash を直接扱う ──────────────────────────────────────────────
//
// trash クレートの os_limited は macOS では提供されない（Finder の "Put Back" に
// 相当する公開 API が無いため）。ここでは ~/.Trash を列挙し、Finder が削除時に
// 付与する拡張属性 com.apple.metadata:_kMDItemDeleteWhereFrom から元の場所を
// 読み取って復元する。
//
// TrashEntry.original_path は「ゴミ箱内の実パス」を入れる（フロントエンドが
// 行の同一性キーとして使い、restore/purge の引数にもなるため一意である必要が
// ある）。元の場所は取得できたときだけ id に併記して復元先に使う。
#[cfg(target_os = "macos")]
mod platform {
    use super::TrashEntry;
    use std::path::{Path, PathBuf};

    const DELETE_WHERE_FROM: &str = "com.apple.metadata:_kMDItemDeleteWhereFrom";

    fn trash_dir() -> Result<PathBuf, String> {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join(".Trash"))
            .ok_or_else(|| "ホームディレクトリを特定できません".to_string())
    }

    /// Finder が付与する削除元パス（バイナリ plist の文字列配列）を読む。
    /// 属性が無い / 壊れている場合は None（＝復元先不明）。
    fn delete_where_from(path: &Path) -> Option<String> {
        let raw = xattr::get(path, DELETE_WHERE_FROM).ok().flatten()?;
        let value: plist::Value = plist::from_bytes(&raw).ok()?;
        let array = value.as_array()?;
        // 配列の先頭が削除元のフルパス（2 要素目以降はボリューム名等）。
        array
            .first()
            .and_then(|v| v.as_string())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }

    /// ディレクトリ配下の合計サイズ（シンボリックリンクは辿らない）。
    fn dir_size(path: &Path) -> u64 {
        let mut total = 0u64;
        let Ok(read) = std::fs::read_dir(path) else {
            return 0;
        };
        for entry in read.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                total = total.saturating_add(dir_size(&entry.path()));
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
        total
    }

    /// 削除日時（UNIX 秒）。~/.Trash へ移動した時刻＝ ctime が最も近い。
    fn deleted_at(meta: &std::fs::Metadata) -> i64 {
        use std::os::unix::fs::MetadataExt;
        meta.ctime()
    }

    pub fn list() -> Result<Vec<TrashEntry>, String> {
        let dir = trash_dir()?;
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            // ゴミ箱が空だとディレクトリ自体が無いことがある。空扱いにする。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };

        let mut entries = Vec::new();
        for entry in read.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            // Finder が使う内部ファイルは見せない。
            if name == ".DS_Store" || name == ".localized" {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let is_dir = meta.is_dir();
            let size = if is_dir { dir_size(&path) } else { meta.len() };
            entries.push(TrashEntry {
                // 元の場所が取れたものはそれを id に入れて UI のツールチップ等に使う。
                id: delete_where_from(&path).unwrap_or_default(),
                name,
                original_path: path.to_string_lossy().into_owned(),
                deleted_at: deleted_at(&meta),
                size,
                is_dir,
            });
        }
        Ok(entries)
    }

    /// 引数のパスが ~/.Trash 配下にあることを確認する。フロントエンドから来た
    /// 任意のパスで restore/purge が走らないようにするためのガード。
    fn ensure_in_trash(path: &Path) -> Result<(), String> {
        let dir = trash_dir()?;
        if path.starts_with(&dir) && path != dir {
            Ok(())
        } else {
            Err(format!(
                "ゴミ箱の外のパスは操作できません: {}",
                path.display()
            ))
        }
    }

    pub fn restore(original_path: &str) -> Result<(), String> {
        let path = PathBuf::from(original_path);
        ensure_in_trash(&path)?;
        if !path.exists() {
            return Err(format!("ゴミ箱にアイテムが見つかりません: {original_path}"));
        }
        let dest = delete_where_from(&path).ok_or_else(|| {
            format!(
                "元の場所が記録されていないため復元できません: {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })?;
        let dest = PathBuf::from(dest);
        if dest.exists() {
            return Err(format!("復元先に同名のアイテムがあります: {}", dest.display()));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&path, &dest).map_err(|e| e.to_string())
    }

    pub fn purge(original_path: &str) -> Result<(), String> {
        let path = PathBuf::from(original_path);
        ensure_in_trash(&path)?;
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| format!("ゴミ箱にアイテムが見つかりません: {original_path}"))?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())
        }
    }

    pub fn empty() -> Result<usize, String> {
        let items = list()?;
        let count = items.len();
        for item in items {
            purge(&item.original_path)?;
        }
        Ok(count)
    }
}
