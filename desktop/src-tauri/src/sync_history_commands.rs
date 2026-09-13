use crate::config::config_dir;
use std::sync::Mutex;

/// 履歴ファイルは「全行読み込み → 書き戻し」で更新するため、コマンドが
/// バックグラウンドスレッドで同時に走っても更新が失われないよう直列化する。
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

/// poison しても処理を継続する（一度のパニックで以降の履歴操作が
/// すべて失敗するのを防ぐ）。
fn lock_history() -> std::sync::MutexGuard<'static, ()> {
    HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// ── 同期履歴の永続化（JSON Lines） ───────────────────────────────────────────
// 1 行 = 1 エントリの JSON。エントリのスキーマ（jobId / direction / name /
// status 等）はフロントエンド（src/lib/syncHistory.ts）が所有し、Rust 側は
// `ts`（Unix 秒）フィールドだけを解釈する（日時指定の破棄に使用）。
// 保持件数の上限はフロントの設定（syncHistoryLimit、既定 10000）を
// append 時に受け取り、超過分を古い順に破棄する。

fn history_path() -> std::path::PathBuf {
    config_dir().join("sync-history.jsonl")
}

fn read_lines() -> Vec<String> {
    let p = history_path();
    if !p.exists() {
        return vec![];
    }
    std::fs::read_to_string(&p)
        .map(|s| {
            s.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn write_lines(lines: &[String]) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body = if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n") + "\n"
    };
    std::fs::write(history_path(), body).map_err(|e| e.to_string())
}

/// 履歴ページ（新しい順）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryPage {
    pub total: usize,
    pub entries: Vec<serde_json::Value>,
}

/// 履歴エントリを末尾に追記し、max_entries を超えた分は古い順に破棄する。
#[tauri::command(async)]
pub fn append_sync_history(
    entries: Vec<serde_json::Value>,
    max_entries: usize,
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let _guard = lock_history();
    let mut lines = read_lines();
    for e in entries {
        lines.push(serde_json::to_string(&e).map_err(|x| x.to_string())?);
    }
    let max = max_entries.max(1);
    if lines.len() > max {
        let drop = lines.len() - max;
        lines.drain(0..drop);
    }
    write_lines(&lines)
}

/// 履歴を新しい順に offset から limit 件返す（パネルの追加読み込み用）。
/// errors_only=true でエラーエントリ（status == "error"）のみに絞り込む
/// （total も絞り込み後の件数になる）。
#[tauri::command(async)]
pub fn load_sync_history(
    offset: usize,
    limit: usize,
    errors_only: Option<bool>,
) -> Result<SyncHistoryPage, String> {
    let _guard = lock_history();
    let lines = read_lines();
    let errors_only = errors_only.unwrap_or(false);
    let parsed: Vec<serde_json::Value> = lines
        .iter()
        .rev()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|v| {
            !errors_only || v.get("status").and_then(|s| s.as_str()) == Some("error")
        })
        .collect();
    let total = parsed.len();
    let entries = parsed
        .into_iter()
        .skip(offset)
        .take(limit.min(1000))
        .collect();
    Ok(SyncHistoryPage { total, entries })
}

/// 指定日時（Unix 秒）以前（ts <= before_ts）の履歴を破棄し、破棄件数を返す。
/// ts が読み取れない壊れた行も併せて破棄する。
#[tauri::command(async)]
pub fn clear_sync_history(before_ts: u64) -> Result<usize, String> {
    let _guard = lock_history();
    let lines = read_lines();
    let total = lines.len();
    let kept: Vec<String> = lines
        .into_iter()
        .filter(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()
                .and_then(|v| v.get("ts").and_then(|t| t.as_u64()))
                .map(|ts| ts > before_ts)
                .unwrap_or(false)
        })
        .collect();
    let removed = total - kept.len();
    write_lines(&kept)?;
    Ok(removed)
}
