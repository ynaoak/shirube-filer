use crate::config::config_dir;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Validate a user-chosen export/import path. The destination comes from the
/// native save/open dialog (or is constructed under the home dir by the app),
/// so we only reject NUL bytes and relative paths rather than confining it to a
/// fixed base — this is a file manager whose other commands already allow
/// full-filesystem access by design, and users legitimately export to any drive.
fn validate_io_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("パスにNULLバイトは使用できません".to_string());
    }
    if !Path::new(path).is_absolute() {
        return Err(format!("絶対パスを指定してください: {}", path));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LayoutFormat {
    Json,
    Yaml,
    Xml,
}

#[tauri::command]
pub fn save_layout(content: String, format: LayoutFormat) -> Result<String, String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let filename = match format {
        LayoutFormat::Json => "layout.json",
        LayoutFormat::Yaml => "layout.yaml",
        LayoutFormat::Xml => "layout.xml",
    };

    let path = dir.join(filename);
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_layout(format: LayoutFormat) -> Result<String, String> {
    let dir = config_dir();
    let filename = match format {
        LayoutFormat::Json => "layout.json",
        LayoutFormat::Yaml => "layout.yaml",
        LayoutFormat::Xml => "layout.xml",
    };

    let path = dir.join(filename);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn export_layout(content: String, path: String) -> Result<(), String> {
    validate_io_path(&path)?;
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, &content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn import_layout(path: String) -> Result<String, String> {
    validate_io_path(&path)?;
    std::fs::read_to_string(Path::new(&path)).map_err(|e| e.to_string())
}
