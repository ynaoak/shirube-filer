use crate::config::{addons_dir, safe_join};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::Mutex;

/// addons.yaml は「読み込み → 書き戻し」で更新するため、コマンドが
/// バックグラウンドスレッドで同時に走っても更新が失われないよう直列化する。
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn lock_config() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AddonMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub license: String,
    pub entry_ui: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AddonState {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct AddonsConfig {
    addons: Vec<AddonState>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AddonInfo {
    pub meta: AddonMeta,
    pub enabled: bool,
    pub dir: String,
}

/// Validate that an addon `id` is a safe directory name:
/// only ASCII alphanumeric characters, hyphens, and underscores.
fn validate_addon_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("アドオンIDは1〜64文字で指定してください".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "アドオンIDに使用できない文字が含まれています: {}",
            id
        ));
    }
    Ok(())
}

fn read_addons_config() -> Vec<AddonState> {
    let path = addons_dir().join("addons.yaml");
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    serde_yaml::from_str::<AddonsConfig>(&content)
        .map(|c| c.addons)
        .unwrap_or_default()
}

fn write_addons_config(states: &[AddonState]) -> Result<(), String> {
    let dir = addons_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config = AddonsConfig {
        addons: states.to_vec(),
    };
    let content = serde_yaml::to_string(&config).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("addons.yaml"), content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_addons() -> Vec<AddonInfo> {
    let dir = addons_dir();
    let states = read_addons_config();

    let mut addons = Vec::new();

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return addons,
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_path = path.join("addon.yaml");
        let content = match std::fs::read_to_string(&meta_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let meta: AddonMeta = match serde_yaml::from_str(&content) {
            Ok(m) => m,
            Err(_) => continue,
        };

        // Validate the id from the manifest before using it in any path operation.
        if validate_addon_id(&meta.id).is_err() {
            continue;
        }

        let enabled = states
            .iter()
            .find(|s| s.id == meta.id)
            .map(|s| s.enabled)
            .unwrap_or(true);

        addons.push(AddonInfo {
            dir: path.to_string_lossy().to_string(),
            meta,
            enabled,
        });
    }

    addons
}

#[tauri::command(async)]
pub fn set_addon_enabled(id: String, enabled: bool) -> Result<(), String> {
    validate_addon_id(&id)?;
    let _guard = lock_config();
    let mut states = read_addons_config();
    if let Some(s) = states.iter_mut().find(|s| s.id == id) {
        s.enabled = enabled;
    } else {
        states.push(AddonState { id, enabled });
    }
    write_addons_config(&states)
}

#[tauri::command(async)]
pub fn get_addon_entry_path(id: String) -> Result<String, String> {
    validate_addon_id(&id)?;

    let dir = addons_dir();
    let addons = list_addons();
    let addon = addons
        .iter()
        .find(|a| a.meta.id == id)
        .ok_or(format!("アドオン '{}' が見つかりません", id))?;

    if !addon.enabled {
        return Err(format!("アドオン '{}' は無効です", id));
    }

    // The addon directory is addons_dir / <id> (id is already validated as safe).
    let addon_dir = dir.join(&id);

    // Build entry path using safe_join to prevent entry_ui from escaping addon_dir.
    let entry_ui_path = std::path::Path::new(&addon.meta.entry_ui);
    let entry = safe_join(&addon_dir, entry_ui_path)
        .ok_or_else(|| format!("entry_uiにパストラバーサルが検出されました: {}", addon.meta.entry_ui))?;

    if !entry.exists() {
        return Err(format!(
            "エントリファイルが存在しません: {}",
            entry.display()
        ));
    }

    Ok(entry.to_string_lossy().to_string())
}

/// Install an addon from a ZIP file.
/// The ZIP must contain `addon.yaml` at the root level and a `ui/` directory.
/// The addon is extracted to `addons_dir/<id>/`.
#[tauri::command(async)]
pub fn install_addon(zip_path: String) -> Result<AddonInfo, String> {
    use std::fs::File;
    use std::io::BufReader;

    let zip_file = File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(BufReader::new(zip_file)).map_err(|e| e.to_string())?;

    // Read and parse addon.yaml from the archive first (validation before extraction)
    let meta: AddonMeta = {
        let mut yaml_entry = archive
            .by_name("addon.yaml")
            .map_err(|_| "ZIPに addon.yaml が含まれていません".to_string())?;
        let mut contents = String::new();
        yaml_entry.read_to_string(&mut contents).map_err(|e| e.to_string())?;
        serde_yaml::from_str(&contents).map_err(|e| format!("addon.yaml のパースに失敗: {}", e))?
    };

    validate_addon_id(&meta.id)?;

    let dest_dir = addons_dir().join(&meta.id);
    if dest_dir.exists() {
        return Err(format!("アドオン '{}' はすでにインストールされています。先にアンインストールしてください。", meta.id));
    }

    // Extract all files
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = entry.mangled_name();
        let out_path = safe_join(&dest_dir, &entry_name)
            .ok_or_else(|| format!("不正なZIPエントリ（パストラバーサル）: {}", entry.name()))?;

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }

    // Register as enabled in addons.yaml
    let _guard = lock_config();
    let mut states = read_addons_config();
    if !states.iter().any(|s| s.id == meta.id) {
        states.push(AddonState { id: meta.id.clone(), enabled: true });
        write_addons_config(&states)?;
    }

    Ok(AddonInfo {
        dir: dest_dir.to_string_lossy().to_string(),
        meta,
        enabled: true,
    })
}

/// Uninstall an addon by ID — removes its directory and config entry.
#[tauri::command(async)]
pub fn uninstall_addon(id: String) -> Result<(), String> {
    validate_addon_id(&id)?;
    let _guard = lock_config();
    let dir = addons_dir().join(&id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    // Remove from config
    let mut states = read_addons_config();
    states.retain(|s| s.id != id);
    write_addons_config(&states)
}
