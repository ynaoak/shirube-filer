use crate::config::config_dir;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[tauri::command]
pub fn load_bookmarks() -> Result<Vec<Bookmark>, String> {
    let path = config_dir().join("bookmarks.yaml");
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_yaml::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_bookmarks(bookmarks: Vec<Bookmark>) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_yaml::to_string(&bookmarks).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("bookmarks.yaml"), content).map_err(|e| e.to_string())
}
