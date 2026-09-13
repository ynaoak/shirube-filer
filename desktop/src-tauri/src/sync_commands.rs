use crate::config::config_dir;

// ── クラウド同期ジョブの永続化 ────────────────────────────────────────────────
// ジョブのスキーマ（プロバイダ種別・認証情報の形・同期設定）はフロントエンド
// （src/store/syncStore.tsx）が所有する。かつてここに Rust 側の型定義
// （SyncProvider enum 等）を置いていたが、フロントにプロバイダを追加した際に
// Rust 側の追随が漏れると、未知のプロバイダを 1 件でも含む配列全体が
// デシリアライズ失敗し保存が丸ごと効かなくなる事故が起きた（さらに未知の
// フィールドは黙って脱落する）。そのため構造は解釈せず JSON 値のまま
// YAML に読み書きする。
// 秘匿値（refreshToken / secretKey 等）はフロントが保存前に取り除いて
// OS キーリングへ保存するため、このファイルには含まれない。

fn jobs_path() -> std::path::PathBuf {
    config_dir().join("cloud-sync.yaml")
}

#[tauri::command]
pub fn load_sync_jobs() -> Result<Vec<serde_json::Value>, String> {
    let p = jobs_path();
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_yaml::from_str::<Vec<serde_json::Value>>(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_sync_jobs(jobs: Vec<serde_json::Value>) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let yaml = serde_yaml::to_string(&jobs).map_err(|e| e.to_string())?;
    std::fs::write(jobs_path(), yaml).map_err(|e| e.to_string())
}
