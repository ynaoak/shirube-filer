use crate::config::config_dir;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct KeyDescriptor {
    pub key: String,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub meta: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KeyBinding {
    pub action: String,
    pub keys: Vec<KeyDescriptor>,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KeybindingsConfig {
    pub version: u32,
    pub bindings: Vec<KeyBinding>,
}

#[tauri::command]
pub fn save_keybindings(config: KeybindingsConfig) -> Result<String, String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("keybindings.yaml");
    let yaml = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, &yaml).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_keybindings() -> Result<KeybindingsConfig, String> {
    let path = config_dir().join("keybindings.yaml");
    let yaml = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_yaml::from_str(&yaml).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_keybindings() -> Result<(), String> {
    let path = config_dir().join("keybindings.yaml");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
