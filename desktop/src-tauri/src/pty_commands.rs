use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtyCwd {
    pub terminal_id: String,
    pub cwd: String,
}

/// Percent-decode a URI path (handles %XX sequences, ASCII-only paths).
fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Ok(h), Ok(l)) = (
                std::str::from_utf8(&bytes[i + 1..i + 2]),
                std::str::from_utf8(&bytes[i + 2..i + 3]),
            ) {
                if let Ok(byte) = u8::from_str_radix(&format!("{}{}", h, l), 16) {
                    result.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

/// Extract the current working directory from an OSC 7 escape sequence.
/// Format: ESC ] 7 ; file://hostname/path BEL  (or ST = ESC \)
fn extract_osc7_cwd(data: &str) -> Option<String> {
    let marker = "\x1b]7;";
    let start = data.find(marker)?;
    let rest = &data[start + marker.len()..];
    let end = rest
        .find('\x07')
        .or_else(|| rest.find("\x1b\\"))?;
    let url = &rest[..end];
    // url is "file://hostname/path" or "file:///path"
    let path_part = url.strip_prefix("file://")?;
    let path = if path_part.starts_with('/') {
        path_part.to_string()
    } else {
        // skip hostname
        let slash = path_part.find('/')?;
        path_part[slash..].to_string()
    };
    let decoded = percent_decode(&path);
    // On Windows the decoded path starts with /C:/… — strip the leading slash
    #[cfg(windows)]
    let decoded = if decoded.starts_with('/') && decoded.len() > 3 && decoded.as_bytes().get(2) == Some(&b':') {
        decoded[1..].to_string()
    } else {
        decoded
    };
    Some(decoded)
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

static PTY_SESSIONS: Lazy<Mutex<HashMap<String, PtySession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const MAX_PTY_SESSIONS: usize = 20;

fn validate_terminal_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("terminal_idは1〜64文字で指定してください".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(
            "terminal_idには英数字・ハイフン・アンダースコアのみ使用できます".to_string(),
        );
    }
    Ok(())
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[tauri::command(async)]
pub fn pty_create(
    terminal_id: String,
    cwd: String,
    shell: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    {
        let mut sessions = PTY_SESSIONS.lock().map_err(|e| e.to_string())?;
        // 既存セッションを削除する (pty_kill と pty_create の競合を防ぐ)
        sessions.remove(&terminal_id);
        if sessions.len() >= MAX_PTY_SESSIONS {
            return Err("最大ターミナルセッション数に達しました".to_string());
        }
    }
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);

    // 端末種別を明示する。
    //
    // GUI から起動したアプリ（macOS で .app を Finder / Dock から開いた場合など）は
    // TERM を持たない。TERM が無いとシェルの行編集（zsh の ZLE、bash の readline）が
    // 無効になり、「バックスペースを押しても文字が消えない」「矢印キーで履歴を辿れない」
    // という状態になる。親から受け継いだ TERM も、実際に描画している xterm.js とは
    // 別物のことがある（例: ターミナルから起動したときの screen / tmux）ので、
    // xterm.js のエミュレーションに合わせて常に上書きする。
    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
    }

    let cwd_path = if cwd.is_empty() {
        #[cfg(windows)]
        {
            std::env::var("USERPROFILE")
                .unwrap_or_else(|_| "C:\\".to_string())
        }
        #[cfg(not(windows))]
        {
            std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        }
    } else {
        cwd.clone()
    };

    cmd.cwd(&cwd_path);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let tid = terminal_id.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    // Detect OSC 7 cwd notification and emit a separate event
                    if let Some(cwd) = extract_osc7_cwd(&data) {
                        let _ = app_clone.emit(
                            "pty-cwd",
                            PtyCwd { terminal_id: tid.clone(), cwd },
                        );
                    }
                    let _ = app_clone.emit(
                        "pty-output",
                        PtyOutput {
                            terminal_id: tid.clone(),
                            data,
                        },
                    );
                }
            }
        }
        // セッションを削除。poison 状態でも続行する（このスレッドがパニックすると
        // 以降の全 PTY 操作が PoisonError になり、ターミナル作成が一切できなくなるため）。
        let mut sessions = match PTY_SESSIONS.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        sessions.remove(&tid);
    });

    let mut sessions = PTY_SESSIONS.lock().map_err(|e| e.to_string())?;
    sessions.insert(
        terminal_id,
        PtySession { writer, master: pair.master, child },
    );

    Ok(())
}

#[tauri::command]
pub fn pty_write(terminal_id: String, data: String) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    let mut sessions = PTY_SESSIONS.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&terminal_id)
        .ok_or("Terminal session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    terminal_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    let sessions = PTY_SESSIONS.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&terminal_id)
        .ok_or("Terminal session not found")?;
    session
        .master
        .resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(terminal_id: String) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    let mut sessions = PTY_SESSIONS.lock().map_err(|e| e.to_string())?;
    sessions.remove(&terminal_id);
    Ok(())
}
