use async_trait::async_trait;
use russh::client;
use russh_keys::key::PublicKey;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

// ── Known-hosts store ─────────────────────────────────────────────────────────

/// Returns `~/.shirube-filer/known_hosts.json`
fn known_hosts_path() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").ok()?;
    #[cfg(not(windows))]
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(home).join(".shirube-filer");
    Some(dir.join("known_hosts.json"))
}

fn load_known_hosts() -> HashMap<String, String> {
    let path = match known_hosts_path() {
        Some(p) => p,
        None => return HashMap::new(),
    };
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_known_hosts(hosts: &HashMap<String, String>) -> Result<(), String> {
    let path = known_hosts_path().ok_or("ホームディレクトリが見つかりません")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(hosts).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ── SSH client handler with TOFU ──────────────────────────────────────────────

struct SshClient {
    host: String,
    port: u16,
}

#[async_trait]
impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let key = format!("{}:{}", self.host, self.port);
        let fp = server_public_key.fingerprint();

        let mut known = load_known_hosts();
        if let Some(stored_fp) = known.get(&key) {
            if stored_fp != &fp {
                // Fingerprint mismatch — possible MITM
                return Err(russh::Error::WrongServerSig);
            }
            // Matches stored fingerprint — trusted
            return Ok(true);
        }

        // First connection — store fingerprint (TOFU)
        known.insert(key, fp);
        save_known_hosts(&known).map_err(|_| russh::Error::WrongServerSig)?;
        Ok(true)
    }
}

// ── SFTP session helper ───────────────────────────────────────────────────────

async fn open_sftp(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
) -> Result<SftpSession, String> {
    let config = Arc::new(client::Config::default());

    let handler = SshClient {
        host: host.to_string(),
        port,
    };

    // 接続確立にもタイムアウトを設ける（黒穴化したホストで UI が固まるのを防ぐ）。
    let mut session = tokio::time::timeout(
        crate::http_client::CONNECT_TIMEOUT,
        client::connect(config, (host, port), handler),
    )
    .await
    .map_err(|_| format!("接続がタイムアウトしました ({}:{})", host, port))?
        .map_err(|e| {
            if matches!(e, russh::Error::WrongServerSig) {
                format!(
                    "ホスト鍵の検証に失敗しました ({}:{})。\
                     中間者攻撃の可能性があります。\
                     信頼できる場合は ~/.shirube-filer/known_hosts.json から該当エントリを削除してください。",
                    host, port
                )
            } else {
                format!("接続失敗 ({}:{}): {}", host, port, e)
            }
        })?;

    let ok = session
        .authenticate_password(user, password)
        .await
        .map_err(|e| format!("認証失敗: {}", e))?;

    if !ok {
        return Err(
            "認証に失敗しました（ユーザー名またはパスワードを確認してください）".to_string(),
        );
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("チャンネルオープン失敗: {}", e))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTPサブシステム起動失敗: {}", e))?;

    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTPセッション作成失敗: {}", e))
}

fn system_time_to_unix(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d: Duration| d.as_secs())
}

/// リモートディレクトリの一覧を取得する
#[tauri::command]
pub async fn sftp_list_dir(
    host: String,
    port: u16,
    user: String,
    password: String,
    remote_path: String,
) -> Result<Vec<SftpEntry>, String> {
    let sftp = open_sftp(&host, port, &user, &password).await?;

    let entries = sftp
        .read_dir(&remote_path)
        .await
        .map_err(|e| format!("ディレクトリ読み取り失敗 ({}): {}", remote_path, e))?;

    let base = remote_path.trim_end_matches('/');
    let mut result: Vec<SftpEntry> = entries
        .into_iter()
        .filter(|e| {
            let name = e.file_name();
            name != "." && name != ".."
        })
        .map(|e| {
            let name = e.file_name().to_string();
            let path = format!("{}/{}", base, name);
            let meta = e.metadata();
            let is_dir = meta.is_dir();
            let size = meta.len();
            let modified = meta
                .modified()
                .ok()
                .and_then(|t: SystemTime| system_time_to_unix(t));
            SftpEntry { name, path, is_dir, size, modified }
        })
        .collect();

    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

/// リモートファイルをローカルにダウンロードする
/// local_path がディレクトリの場合はリモートのファイル名をそのまま使用する
#[tauri::command]
pub async fn sftp_download(
    host: String,
    port: u16,
    user: String,
    password: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let sftp = open_sftp(&host, port, &user, &password).await?;

    let mut file = sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("リモートファイルを開けません ({}): {}", remote_path, e))?;

    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| format!("読み取り失敗: {}", e))?;

    let local = std::path::Path::new(&local_path);
    let dest = if local.is_dir() {
        let filename = std::path::Path::new(&remote_path)
            .file_name()
            .ok_or_else(|| "リモートファイル名を取得できません".to_string())?;
        local.join(filename)
    } else {
        local.to_path_buf()
    };

    std::fs::write(&dest, &buf)
        .map_err(|e| format!("ローカル書き込み失敗 ({}): {}", dest.display(), e))?;

    Ok(())
}

/// リモートのディレクトリを再帰的に作成する（mkdir -p 相当）。
/// 既に存在する階層はスキップする（冪等）。
#[tauri::command]
pub async fn sftp_mkdirs(
    host: String,
    port: u16,
    user: String,
    password: String,
    remote_path: String,
) -> Result<(), String> {
    let sftp = open_sftp(&host, port, &user, &password).await?;
    // 先頭からスラッシュ区切りで1階層ずつ作成。絶対パス先頭の "/" を維持する。
    let is_absolute = remote_path.starts_with('/');
    let mut acc = String::new();
    for (i, comp) in remote_path.split('/').filter(|c| !c.is_empty()).enumerate() {
        if i == 0 && is_absolute {
            acc.push('/');
        } else if !acc.is_empty() && !acc.ends_with('/') {
            acc.push('/');
        }
        acc.push_str(comp);
        // 既に存在する場合のエラーは無視（冪等性のため）。
        let _ = sftp.create_dir(&acc).await;
    }
    Ok(())
}

/// ローカルファイルをリモートにアップロードする
/// remote_path がディレクトリの場合はローカルのファイル名をそのまま使用する
#[tauri::command]
pub async fn sftp_upload(
    host: String,
    port: u16,
    user: String,
    password: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let sftp = open_sftp(&host, port, &user, &password).await?;

    let data = std::fs::read(&local_path)
        .map_err(|e| format!("ローカルファイル読み取り失敗 ({}): {}", local_path, e))?;

    // remote_path がディレクトリならローカルのファイル名を付加する
    let dest = match sftp.metadata(&remote_path).await {
        Ok(attrs) if attrs.is_dir() => {
            let filename = std::path::Path::new(&local_path)
                .file_name()
                .ok_or_else(|| "ローカルファイル名を取得できません".to_string())?
                .to_string_lossy();
            format!("{}/{}", remote_path.trim_end_matches('/'), filename)
        }
        _ => remote_path.clone(),
    };

    let mut file = sftp
        .create(&dest)
        .await
        .map_err(|e| format!("リモートファイル作成失敗 ({}): {}", dest, e))?;

    file.write_all(&data)
        .await
        .map_err(|e| format!("書き込み失敗: {}", e))?;

    file.shutdown()
        .await
        .map_err(|e| format!("ファイルクローズ失敗: {}", e))?;

    Ok(())
}

/// リモートのファイルを削除する（双方向同期の削除反映で使用）。
#[tauri::command]
pub async fn sftp_delete(
    host: String,
    port: u16,
    user: String,
    password: String,
    remote_path: String,
) -> Result<(), String> {
    let sftp = open_sftp(&host, port, &user, &password).await?;
    sftp.remove_file(&remote_path)
        .await
        .map_err(|e| format!("リモートファイル削除失敗 ({}): {}", remote_path, e))?;
    Ok(())
}
