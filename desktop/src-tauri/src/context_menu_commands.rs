use crate::config::config_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMenuItem {
    pub id: String,
    pub label: String,
    pub icon: String,
    /// Shell command template.
    /// Placeholders: {path} {paths} {dir} {name}
    pub command: String,
    /// "all" | "file" | "dir" — when to show this item
    #[serde(default = "default_on")]
    pub on: String,
}

fn default_on() -> String {
    "all".to_string()
}

fn config_file() -> PathBuf {
    config_dir().join("context_menu.json")
}

#[tauri::command]
pub fn load_context_menu_config() -> Result<Vec<CustomMenuItem>, String> {
    let path = config_file();
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_context_menu_config(items: Vec<CustomMenuItem>) -> Result<(), String> {
    let path = config_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Run a user-configured shell command string.
/// On Windows: cmd.exe /C <command>
/// On Unix/macOS: sh -c <command>
#[cfg(not(feature = "msstore"))]
#[tauri::command(async)]
pub fn run_user_command(command: String, cwd: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", &command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", &command]);
        c
    };

    if let Some(dir) = &cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }

    // Detach: spawn without waiting so the file manager stays responsive
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}
