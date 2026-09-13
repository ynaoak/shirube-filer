use crate::config::config_dir;
use serde::Serialize;

const SETTINGS_FILE: &str = "settings.json";

/// ユーザー設定ファイル (settings.json) を読み込む。
/// ファイルが存在しない場合は空文字列を返す（エラーにしない）。
#[tauri::command]
pub fn load_ui_settings() -> Result<String, String> {
    let path = config_dir().join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// ユーザー設定ファイル (settings.json) に書き込む。
#[tauri::command]
pub fn save_ui_settings(json: String) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(SETTINGS_FILE);
    std::fs::write(&path, json.as_bytes()).map_err(|e| e.to_string())
}

/// ユーザー設定ファイルのパスを返す（UI 上で表示用）。
#[tauri::command]
pub fn get_ui_settings_path() -> String {
    config_dir().join(SETTINGS_FILE).to_string_lossy().to_string()
}

/// アプリの全データを削除する（初期化）。設定ディレクトリ（config_dir）を
/// 中身ごと削除する。OS 資格情報ストアのシークレットと localStorage は、
/// 本コマンドを呼ぶ前にフロント側で削除しておくこと。
#[tauri::command(async)]
pub fn clear_app_data() -> Result<(), String> {
    let dir = config_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// システムにインストールされているシェル/ターミナルアプリの一覧を返す。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShell {
    pub name: String,
    pub path: String,
}

#[tauri::command(async)]
pub fn list_shells() -> Vec<DetectedShell> {
    let mut result: Vec<DetectedShell> = Vec::new();

    #[cfg(windows)]
    {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let user_profile = std::env::var("USERPROFILE").unwrap_or_default();

        // コマンドプロンプト
        let cmd = format!("{}\\System32\\cmd.exe", sysroot);
        if std::path::Path::new(&cmd).exists() {
            result.push(DetectedShell { name: "コマンドプロンプト (cmd.exe)".into(), path: cmd });
        }

        // Windows PowerShell 5
        let ps5 = format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", sysroot);
        if std::path::Path::new(&ps5).exists() {
            result.push(DetectedShell { name: "Windows PowerShell 5 (powershell.exe)".into(), path: ps5 });
        }

        // PowerShell 7+ (バージョンディレクトリを列挙)
        let ps_dir = std::path::Path::new(&program_files).join("PowerShell");
        if let Ok(entries) = std::fs::read_dir(&ps_dir) {
            let mut ps_entries: Vec<_> = entries.flatten().collect();
            ps_entries.sort_by_key(|e| e.file_name());
            ps_entries.reverse(); // 新しいバージョンを先に
            for entry in ps_entries {
                let pwsh = entry.path().join("pwsh.exe");
                if pwsh.exists() {
                    let ver = entry.file_name().to_string_lossy().to_string();
                    result.push(DetectedShell {
                        name: format!("PowerShell {} (pwsh.exe)", ver),
                        path: pwsh.to_string_lossy().into_owned(),
                    });
                }
            }
        }

        // WSL
        let wsl = format!("{}\\System32\\wsl.exe", sysroot);
        if std::path::Path::new(&wsl).exists() {
            result.push(DetectedShell { name: "WSL (wsl.exe)".into(), path: wsl });
        }

        // Git Bash (一般的なインストール先を確認)
        let git_bash_candidates = vec![
            format!("{}\\Git\\bin\\bash.exe", program_files),
            format!("{}\\Git\\git-bash.exe", program_files),
            "C:\\Program Files (x86)\\Git\\bin\\bash.exe".to_string(),
            format!("{}\\scoop\\apps\\git\\current\\bin\\bash.exe", user_profile),
        ];
        for p in &git_bash_candidates {
            if std::path::Path::new(p).exists() {
                let label = if p.ends_with("bash.exe") { "Git Bash (bash.exe)" } else { "Git Bash" };
                result.push(DetectedShell { name: label.into(), path: p.clone() });
                break;
            }
        }

        // Windows Terminal (WindowsApps または Scoop)
        let wt_candidates = vec![
            format!("{}\\Microsoft\\WindowsApps\\wt.exe", local_app_data),
            format!("{}\\scoop\\apps\\windows-terminal\\current\\wt.exe", user_profile),
        ];
        for p in &wt_candidates {
            if std::path::Path::new(p).exists() {
                result.push(DetectedShell { name: "Windows Terminal (wt.exe)".into(), path: p.clone() });
                break;
            }
        }

        // MSYS2 (Scoop または標準インストール)
        let msys2_candidates = vec![
            "C:\\msys64\\usr\\bin\\bash.exe".to_string(),
            "C:\\msys64\\msys2_shell.cmd".to_string(),
            format!("{}\\scoop\\apps\\msys2\\current\\usr\\bin\\bash.exe", user_profile),
        ];
        for p in &msys2_candidates {
            if std::path::Path::new(p).exists() {
                result.push(DetectedShell { name: "MSYS2 Bash".into(), path: p.clone() });
                break;
            }
        }

        // Cygwin
        let cyg = "C:\\cygwin64\\bin\\bash.exe";
        if std::path::Path::new(cyg).exists() {
            result.push(DetectedShell { name: "Cygwin Bash".into(), path: cyg.into() });
        }
    }

    #[cfg(not(windows))]
    {
        let unix_candidates: &[(&str, &str)] = &[
            ("/bin/zsh",                   "Zsh (/bin/zsh)"),
            ("/bin/bash",                  "Bash (/bin/bash)"),
            ("/bin/fish",                  "Fish (/bin/fish)"),
            ("/bin/sh",                    "sh (/bin/sh)"),
            ("/usr/bin/zsh",               "Zsh (/usr/bin/zsh)"),
            ("/usr/bin/bash",              "Bash (/usr/bin/bash)"),
            ("/usr/bin/fish",              "Fish (/usr/bin/fish)"),
            ("/opt/homebrew/bin/zsh",      "Zsh (Homebrew)"),
            ("/opt/homebrew/bin/bash",     "Bash (Homebrew)"),
            ("/opt/homebrew/bin/fish",     "Fish (Homebrew)"),
            ("/usr/local/bin/zsh",         "Zsh (Homebrew)"),
            ("/usr/local/bin/bash",        "Bash (Homebrew)"),
            ("/usr/local/bin/fish",        "Fish (Homebrew)"),
        ];
        for (path, name) in unix_candidates {
            if std::path::Path::new(path).exists() {
                result.push(DetectedShell { name: (*name).into(), path: (*path).into() });
            }
        }
    }

    result
}
