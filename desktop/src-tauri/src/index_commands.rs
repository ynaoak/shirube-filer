use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use jwalk::WalkDir as JWalkDir;
use memchr::memmem;
use rayon::prelude::*;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Directories skipped while building the index.
const EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    ".cache",
    "__pycache__",
    "$RECYCLE.BIN",
    "System Volume Information",
];

/// Below this entry count, a single-threaded scan with early-out is faster than
/// paying for rayon's fan-out. Above it, parallel scanning wins.
const PARALLEL_SEARCH_THRESHOLD: usize = 30_000;

#[derive(Clone)]
pub struct IndexEntry {
    pub name: String,
    pub name_lower: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub extension: Option<String>,
}

#[derive(Default)]
pub struct IndexData {
    pub entries: Vec<IndexEntry>,
    pub roots: Vec<String>,
    pub indexed_at: Option<u64>,
    pub building: bool,
}

/// Shared, in-memory file-name index. Built on demand, scanned per keystroke.
pub struct IndexState(pub RwLock<IndexData>);

impl Default for IndexState {
    fn default() -> Self {
        IndexState(RwLock::new(IndexData::default()))
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub building: bool,
    pub count: usize,
    pub indexed_at: Option<u64>,
    pub roots: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexHit {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub extension: Option<String>,
}

fn now_secs() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

impl IndexEntry {
    #[inline]
    fn to_hit(&self) -> IndexHit {
        IndexHit {
            name: self.name.clone(),
            path: self.path.clone(),
            is_dir: self.is_dir,
            size: self.size,
            modified: self.modified,
            extension: self.extension.clone(),
        }
    }
}

/// Build (or rebuild) the in-memory file-name index for the given roots.
/// Emits `index:progress` (current entry count) periodically and
/// `index:done` (final count) on completion.
///
/// Traversal is two-phase: a jwalk-parallel enumeration (directory reads are
/// fanned out across the rayon pool), followed by a rayon-parallel build of the
/// per-entry records (lowercasing, path/extension string work, metadata).
#[tauri::command]
pub async fn build_index(
    app: AppHandle,
    state: State<'_, IndexState>,
    roots: Vec<String>,
) -> Result<usize, String> {
    // Mark as building (reject concurrent builds). Guard dropped before await.
    {
        let mut data = state.0.write().map_err(|e| e.to_string())?;
        if data.building {
            return Err("インデックスを作成中です".to_string());
        }
        data.building = true;
    }

    let roots_for_walk = roots.clone();
    let app_for_walk = app.clone();

    let joined = tokio::task::spawn_blocking(move || {
        // Phase 1: enumerate the tree. jwalk fans the directory reads out across
        // the rayon pool internally, so this scales with cores. Excluded
        // directories are pruned in `process_read_dir` so we never descend into
        // them. Type of `raw` is inferred (jwalk::DirEntry<((), ())>).
        let mut raw = Vec::new();
        for root in &roots_for_walk {
            let walker = JWalkDir::new(root)
                .skip_hidden(false)
                .follow_links(false)
                .process_read_dir(|_depth, _path, _state, children| {
                    children.retain(|res| {
                        res.as_ref()
                            .map(|e| {
                                if e.file_type().is_dir() {
                                    let name = e.file_name.to_string_lossy();
                                    !EXCLUDE_DIRS.contains(&&*name)
                                } else {
                                    true
                                }
                            })
                            .unwrap_or(true)
                    });
                });

            for entry in walker {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                if entry.depth() == 0 {
                    continue;
                }
                raw.push(entry);
                if raw.len() % 5000 == 0 {
                    let _ = app_for_walk.emit("index:progress", raw.len());
                }
            }
        }

        // Phase 2: build records in parallel across all cores.
        raw.into_par_iter()
            .map(|entry| {
                let name = entry.file_name.to_string_lossy().to_string();
                let ft = entry.file_type();
                let meta = entry.metadata().ok();
                let modified = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());
                let size = if ft.is_file() {
                    meta.as_ref().map(|m| m.len()).unwrap_or(0)
                } else {
                    0
                };
                let extension = entry
                    .path()
                    .extension()
                    .map(|x| x.to_string_lossy().to_string());

                IndexEntry {
                    name_lower: name.to_lowercase(),
                    name,
                    path: entry.path().to_string_lossy().to_string(),
                    is_dir: ft.is_dir(),
                    size,
                    modified,
                    extension,
                }
            })
            .collect::<Vec<IndexEntry>>()
    })
    .await;

    let entries = match joined {
        Ok(v) => v,
        Err(e) => {
            // Reset building flag so the user can retry.
            if let Ok(mut data) = state.0.write() {
                data.building = false;
            }
            return Err(e.to_string());
        }
    };

    let count = entries.len();
    {
        let mut data = state.0.write().map_err(|e| e.to_string())?;
        data.entries = entries;
        data.roots = roots;
        data.indexed_at = now_secs();
        data.building = false;
    }

    let _ = app.emit("index:done", count);
    Ok(count)
}

/// Search the in-memory index. Space-separated terms are AND-matched
/// against the lowercased file name (substring match).
///
/// Matching uses `memchr::memmem::Finder` (needles compiled once and reused
/// across every entry — far faster than `str::contains` per call). Large
/// indexes are scanned with rayon; small ones use a single-threaded early-out.
// インデックス全体の走査は CPU バウンドで、入力のたびに呼ばれる。
// メインスレッドで実行すると打鍵中に UI が固まるためバックグラウンド実行にする。
#[tauri::command(async)]
pub fn search_index(
    state: State<'_, IndexState>,
    query: String,
    max_results: usize,
    dirs_only: bool,
) -> Result<Vec<IndexHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let terms: Vec<String> = q.split_whitespace().map(|s| s.to_string()).collect();
    let finders: Vec<memmem::Finder> = terms
        .iter()
        .map(|t| memmem::Finder::new(t.as_bytes()))
        .collect();
    let max = if max_results == 0 { 500 } else { max_results };

    let data = state.0.read().map_err(|e| e.to_string())?;

    let matches = |e: &IndexEntry| -> bool {
        if dirs_only && !e.is_dir {
            return false;
        }
        let hay = e.name_lower.as_bytes();
        finders.iter().all(|f| f.find(hay).is_some())
    };

    let hits: Vec<IndexHit> = if data.entries.len() >= PARALLEL_SEARCH_THRESHOLD {
        // Parallel filter collects only matching references (cheap pointers),
        // truncates to the cap, then clones at most `max` records.
        let mut refs: Vec<&IndexEntry> =
            data.entries.par_iter().filter(|e| matches(e)).collect();
        refs.truncate(max);
        refs.iter().map(|e| e.to_hit()).collect()
    } else {
        // Single-threaded with early-out — fastest for small indexes.
        let mut v: Vec<IndexHit> = Vec::new();
        for e in data.entries.iter() {
            if matches(e) {
                v.push(e.to_hit());
                if v.len() >= max {
                    break;
                }
            }
        }
        v
    };

    Ok(hits)
}

/// Return current index status (building flag, entry count, timestamp, roots).
#[tauri::command]
pub fn index_status(state: State<'_, IndexState>) -> Result<IndexStatus, String> {
    let data = state.0.read().map_err(|e| e.to_string())?;
    Ok(IndexStatus {
        building: data.building,
        count: data.entries.len(),
        indexed_at: data.indexed_at,
        roots: data.roots.clone(),
    })
}

/// Drop the in-memory index, freeing memory.
#[tauri::command]
pub fn clear_index(state: State<'_, IndexState>) -> Result<(), String> {
    let mut data = state.0.write().map_err(|e| e.to_string())?;
    data.entries.clear();
    data.roots.clear();
    data.indexed_at = None;
    Ok(())
}
