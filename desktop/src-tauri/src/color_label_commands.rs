use crate::config::config_dir;
use std::collections::HashMap;

/// Color label store: maps an absolute file path to a hex color string (e.g. "#ef4444").
/// Persisted as YAML at ~/.shirube-filer/color-labels.yaml.
type ColorLabelMap = HashMap<String, String>;

fn color_labels_path() -> std::path::PathBuf {
    config_dir().join("color-labels.yaml")
}

/// Load the color label map. Returns an empty map if the file does not exist.
#[tauri::command]
pub fn load_color_labels() -> Result<ColorLabelMap, String> {
    let path = color_labels_path();
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_yaml::from_str(&content).map_err(|e| e.to_string())
}

/// Persist the color label map. Entries are saved as-is; callers should prune
/// empty entries before calling this.
#[tauri::command]
pub fn save_color_labels(labels: ColorLabelMap) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_yaml::to_string(&labels).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("color-labels.yaml"), content).map_err(|e| e.to_string())
}
