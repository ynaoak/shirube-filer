use crate::config::config_dir;
use serde::{Deserialize, Serialize};

/// 1 つの自動化ルール。条件にマッチしたファイルへアクションを適用する。
/// 実行ロジック自体はフロントエンド側 (ruleStore + LayoutRoot) で行い、
/// ここでは永続化のみ担当する。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// fs:changed イベントを受けて自動実行するか。false の場合は
    /// UI からの手動実行（プレビューを含む）のみ。
    pub auto_run: bool,
    pub watch_path: String,
    pub conditions: RuleConditions,
    pub actions: Vec<RuleAction>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuleConditions {
    /// 大小無視の拡張子集合（先頭の `.` は付けない）。空なら拡張子で絞らない。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extensions: Vec<String>,
    /// 簡易 glob (`*` のみ対応、大文字小文字無視)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_pattern: Option<String>,
    /// バイト数下限（ファイルのみ）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_size: Option<u64>,
}

/// 適用アクション。`move` は watchPath/<destSubdir>/<basename> へ移動する。
/// `destSubdir` は単一階層のサブフォルダ名のみ許可し、パスセパレータや
/// `..` を含む値はフロント側で拒否する（無限ループ・経路抜け防止）。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RuleAction {
    Move { dest_subdir: String },
    AddTag { tag: String },
    SetLabel { color: String },
}

fn rules_path() -> std::path::PathBuf {
    config_dir().join("rules.yaml")
}

#[tauri::command]
pub fn load_rules() -> Result<Vec<AutomationRule>, String> {
    let p = rules_path();
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_yaml::from_str::<Vec<AutomationRule>>(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_rules(rules: Vec<AutomationRule>) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let yaml = serde_yaml::to_string(&rules).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("rules.yaml"), yaml).map_err(|e| e.to_string())
}
