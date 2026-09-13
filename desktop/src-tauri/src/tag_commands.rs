use crate::config::config_dir;
use std::collections::HashMap;

/// Tag store: maps an absolute file path to its list of tags.
/// Persisted as YAML at ~/.shirube-filer/tags.yaml.
type TagMap = HashMap<String, Vec<String>>;

fn tags_path() -> std::path::PathBuf {
    config_dir().join("tags.yaml")
}

/// Load the entire tag map. Returns an empty map if the file does not exist.
#[tauri::command]
pub fn load_tags() -> Result<TagMap, String> {
    let path = tags_path();
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_yaml::from_str(&content).map_err(|e| e.to_string())
}

/// Persist the entire tag map. Entries with no tags are pruned before saving
/// so the file stays compact.
#[tauri::command]
pub fn save_tags(tags: TagMap) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pruned: TagMap = tags
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect();
    let content = serde_yaml::to_string(&pruned).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("tags.yaml"), content).map_err(|e| e.to_string())
}
