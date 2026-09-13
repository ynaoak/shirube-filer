use crate::oauth_state::{
    generate_code_challenge, generate_code_verifier, url_encode, wait_for_oauth_code,
    OAuthDispatcher,
};
use crate::progress::CancelState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DropboxTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DropboxEntry {
    pub id: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    /// ファイル操作に使用するパス（例: "/Documents/file.txt"）
    pub path_display: String,
}

// ── Internal serde types ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct RefreshTokenResponse {
    access_token: String,
}

#[derive(Deserialize)]
struct ListFolderResponse {
    entries: Vec<DropboxItem>,
    cursor: String,
    has_more: bool,
}

#[derive(Deserialize)]
struct DropboxItem {
    #[serde(rename = ".tag")]
    tag: String,
    id: String,
    name: String,
    size: Option<u64>,
    #[serde(rename = "server_modified")]
    server_modified: Option<String>,
    path_display: Option<String>,
}

#[derive(Deserialize)]
struct CreateFolderResponse {
    metadata: DropboxItem,
}

// ── OAuth config ─────────────────────────────────────────────────────────────

const OAUTH_AUTH_URL: &str = "https://www.dropbox.com/oauth2/authorize";
const OAUTH_TOKEN_URL: &str = "https://api.dropboxapi.com/oauth2/token";

/// 登録手順: Dropbox App Console でアプリを作成し、
/// Redirect URIs に `shirube-filer://oauth/dropbox` を追加して App key をここに設定してください。
/// PKCE を使用するため App secret の埋め込みは不要です。
/// ビルド時に環境変数 `SHIRUBE_DROPBOX_APP_KEY` が設定されていればそちらを優先します
/// （未設定なら下記のプレースホルダにフォールバック）。
const BUNDLED_CLIENT_ID: &str = match option_env!("SHIRUBE_DROPBOX_APP_KEY") {
    Some(v) => v,
    None => "REPLACE_WITH_DROPBOX_APP_KEY",
};

const REDIRECT_URI: &str = "shirube-filer://oauth/dropbox";
const SERVICE_KEY: &str = "dropbox";
const RPC_BASE: &str = "https://api.dropboxapi.com/2";
const CONTENT_BASE: &str = "https://content.dropboxapi.com/2";

// ── Tauri commands ────────────────────────────────────────────────────────────

/// OAuth 2.0 PKCE フローを開始し、Dropbox の認証トークンを取得する。
#[tauri::command]
pub async fn dropbox_start_oauth_flow(
    dispatcher: tauri::State<'_, OAuthDispatcher>,
) -> Result<DropboxTokens, String> {
    let code_verifier = generate_code_verifier();
    let code_challenge = generate_code_challenge(&code_verifier);

    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code\
         &code_challenge={}&code_challenge_method=S256&token_access_type=offline",
        OAUTH_AUTH_URL,
        url_encode(BUNDLED_CLIENT_ID),
        url_encode(REDIRECT_URI),
        url_encode(&code_challenge),
    );

    let code = wait_for_oauth_code(&dispatcher, SERVICE_KEY, &auth_url).await?;

    let client = crate::http_client::client();
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", BUNDLED_CLIENT_ID),
            ("code", code.as_str()),
            ("code_verifier", code_verifier.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("トークン交換リクエスト失敗: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("トークン交換失敗 ({}): {}", status, body));
    }

    let tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("トークンレスポンス解析失敗: {}", e))?;

    Ok(DropboxTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// refresh_token を使って新しい access_token を取得する。
#[tauri::command]
pub async fn dropbox_refresh_access_token(
    refresh_token: String,
) -> Result<String, String> {
    let client = crate::http_client::client();
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", BUNDLED_CLIENT_ID),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("アクセストークン更新リクエスト失敗: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("アクセストークン更新失敗 ({}): {}", status, body));
    }

    let data: RefreshTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("レスポンス解析失敗: {}", e))?;

    Ok(data.access_token)
}

/// フォルダ内のアイテム一覧を取得する（ページネーション対応）。
/// folder_path に "" を指定するとルートを取得する。
#[tauri::command]
pub async fn dropbox_list_folder(
    access_token: String,
    folder_path: String,
) -> Result<Vec<DropboxEntry>, String> {
    let client = crate::http_client::client();
    let mut entries: Vec<DropboxEntry> = Vec::new();

    // 初回リクエスト
    let init_body = format!(
        r#"{{"path":"{}","recursive":false,"include_deleted":false,"limit":2000}}"#,
        folder_path.replace('"', "\\\"")
    );

    let init_resp = client
        .post(&format!("{}/files/list_folder", RPC_BASE))
        .bearer_auth(&access_token)
        .header("Content-Type", "application/json")
        .body(init_body)
        .send()
        .await
        .map_err(|e| format!("フォルダ一覧取得失敗: {}", e))?;

    if !init_resp.status().is_success() {
        let status = init_resp.status();
        let body = init_resp.text().await.unwrap_or_default();
        return Err(format!("フォルダ一覧取得エラー ({}): {}", status, body));
    }

    let mut data: ListFolderResponse = init_resp
        .json()
        .await
        .map_err(|e| format!("レスポンス解析失敗: {}", e))?;

    collect_entries(&mut entries, data.entries);

    // 続きがある場合はカーソルで取得
    while data.has_more {
        let cont_body = format!(r#"{{"cursor":"{}"}}"#, data.cursor.replace('"', "\\\""));
        let cont_resp = client
            .post(&format!("{}/files/list_folder/continue", RPC_BASE))
            .bearer_auth(&access_token)
            .header("Content-Type", "application/json")
            .body(cont_body)
            .send()
            .await
            .map_err(|e| format!("フォルダ一覧続き取得失敗: {}", e))?;

        if !cont_resp.status().is_success() {
            let status = cont_resp.status();
            let body = cont_resp.text().await.unwrap_or_default();
            return Err(format!("フォルダ一覧続き取得エラー ({}): {}", status, body));
        }

        data = cont_resp.json().await.map_err(|e| format!("レスポンス解析失敗: {}", e))?;
        collect_entries(&mut entries, data.entries);
    }

    // フォルダ優先・名前順
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

fn collect_entries(entries: &mut Vec<DropboxEntry>, items: Vec<DropboxItem>) {
    for item in items {
        if item.tag == "deleted" {
            continue;
        }
        let is_dir = item.tag == "folder";
        let path_display = item.path_display.clone().unwrap_or_default();
        entries.push(DropboxEntry {
            id: item.id,
            name: item.name,
            is_dir,
            size: item.size.unwrap_or(0),
            modified: item.server_modified,
            path_display,
        });
    }
}

/// Dropbox ファイルをローカルにダウンロードする（ストリーミング・キャンセル対応）。
#[tauri::command]
pub async fn dropbox_download_file(
    access_token: String,
    path: String,
    file_name: String,
    local_path: String,
    cancel: tauri::State<'_, CancelState>,
) -> Result<(), String> {
    let flag = cancel.begin();

    let local = std::path::Path::new(&local_path);
    let dest = if local.is_dir() { local.join(&file_name) } else { local.to_path_buf() };

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let api_arg = format!(r#"{{"path":"{}"}}"#, path.replace('"', "\\\""));
    let client = crate::http_client::client();
    let mut resp = client
        .post(&format!("{}/files/download", CONTENT_BASE))
        .bearer_auth(&access_token)
        .header("Dropbox-API-Arg", &api_arg)
        .header("Content-Type", "")
        .send()
        .await
        .map_err(|e| format!("ダウンロードリクエスト失敗: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ダウンロード失敗 {} ({}): {}", file_name, status, body));
    }

    let mut dest_file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("ファイル作成失敗: {}", e))?;

    loop {
        if flag.load(Ordering::Relaxed) {
            drop(dest_file);
            tokio::fs::remove_file(&dest).await.ok();
            cancel.end();
            return Err("キャンセルされました".to_string());
        }
        match resp.chunk().await.map_err(|e| format!("ダウンロード中エラー: {}", e))? {
            Some(chunk) => dest_file.write_all(&chunk).await.map_err(|e| format!("書き込みエラー: {}", e))?,
            None => break,
        }
    }

    cancel.end();
    Ok(())
}

/// ローカルファイルを Dropbox にアップロードする（150MB まではストリーミング、超過はセッション）。
#[tauri::command]
pub async fn dropbox_upload_file(
    access_token: String,
    folder_path: String,
    local_path: String,
    cancel: tauri::State<'_, CancelState>,
) -> Result<(), String> {
    let flag = cancel.begin();

    let path = std::path::Path::new(&local_path);
    let filename = path
        .file_name()
        .ok_or_else(|| "ファイル名を取得できません".to_string())?
        .to_string_lossy()
        .to_string();

    let dest_path = if folder_path.is_empty() {
        format!("/{}", filename)
    } else {
        format!("{}/{}", folder_path.trim_end_matches('/'), filename)
    };

    let meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("ファイル情報取得失敗: {}", e))?;
    let file_size = meta.len();

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let client = crate::http_client::client();
    const SIMPLE_LIMIT: u64 = 150 * 1024 * 1024;

    if file_size <= SIMPLE_LIMIT {
        // シンプルアップロード（150MB 以下）
        let api_arg = format!(
            r#"{{"path":"{}","mode":"overwrite","autorename":false}}"#,
            dest_path.replace('"', "\\\"")
        );
        let file = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| format!("ファイルオープン失敗: {}", e))?;

        let resp = client
            .post(&format!("{}/files/upload", CONTENT_BASE))
            .bearer_auth(&access_token)
            .header("Dropbox-API-Arg", &api_arg)
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", file_size.to_string())
            .body(reqwest::Body::from(file))
            .send()
            .await
            .map_err(|e| format!("アップロード失敗 ({}): {}", filename, e))?;

        cancel.end();

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("アップロードエラー {} ({}): {}", filename, status, body));
        }
        return Ok(());
    }

    // 150MB 超はアップロードセッション
    const CHUNK_SIZE: usize = 150 * 1024 * 1024;
    let mut file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("ファイルオープン失敗: {}", e))?;

    // セッション開始
    let start_resp = client
        .post(&format!("{}/files/upload_session/start", CONTENT_BASE))
        .bearer_auth(&access_token)
        .header("Dropbox-API-Arg", r#"{"close":false}"#)
        .header("Content-Type", "application/octet-stream")
        .body(Vec::<u8>::new())
        .send()
        .await
        .map_err(|e| format!("アップロードセッション開始失敗: {}", e))?;

    if !start_resp.status().is_success() {
        let status = start_resp.status();
        let body = start_resp.text().await.unwrap_or_default();
        cancel.end();
        return Err(format!("アップロードセッション開始エラー ({}): {}", status, body));
    }

    let start_data: serde_json::Value = start_resp
        .json()
        .await
        .map_err(|e| format!("セッションレスポンス解析失敗: {}", e))?;
    let session_id = start_data["session_id"]
        .as_str()
        .ok_or_else(|| "session_id が取得できません".to_string())?
        .to_string();

    let mut offset: u64 = 0;
    let mut buf = vec![0u8; CHUNK_SIZE];

    loop {
        if flag.load(Ordering::Relaxed) {
            cancel.end();
            return Err("キャンセルされました".to_string());
        }

        use tokio::io::AsyncReadExt;
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("ファイル読み込み失敗: {}", e))?;
        if n == 0 { break; }

        let is_last = offset + n as u64 >= file_size;
        let chunk = buf[..n].to_vec();

        if is_last {
            let arg = format!(
                r#"{{"cursor":{{"session_id":"{}","offset":{}}},"commit":{{"path":"{}","mode":"overwrite"}}}}"#,
                session_id,
                offset,
                dest_path.replace('"', "\\\"")
            );
            let finish_resp = client
                .post(&format!("{}/files/upload_session/finish", CONTENT_BASE))
                .bearer_auth(&access_token)
                .header("Dropbox-API-Arg", &arg)
                .header("Content-Type", "application/octet-stream")
                .body(chunk)
                .send()
                .await
                .map_err(|e| format!("アップロード完了失敗: {}", e))?;

            cancel.end();

            if !finish_resp.status().is_success() {
                let status = finish_resp.status();
                let body = finish_resp.text().await.unwrap_or_default();
                return Err(format!("アップロード完了エラー ({}): {}", status, body));
            }
            return Ok(());
        }

        let arg = format!(
            r#"{{"cursor":{{"session_id":"{}","offset":{}}},"close":false}}"#,
            session_id, offset
        );
        let append_resp = client
            .post(&format!("{}/files/upload_session/append_v2", CONTENT_BASE))
            .bearer_auth(&access_token)
            .header("Dropbox-API-Arg", &arg)
            .header("Content-Type", "application/octet-stream")
            .body(chunk)
            .send()
            .await
            .map_err(|e| format!("チャンクアップロード失敗: {}", e))?;

        if !append_resp.status().is_success() {
            let status = append_resp.status();
            let body = append_resp.text().await.unwrap_or_default();
            cancel.end();
            return Err(format!("チャンクアップロードエラー ({}): {}", status, body));
        }

        offset += n as u64;
    }

    cancel.end();
    Ok(())
}

/// Dropbox アイテムを削除する。
#[tauri::command]
pub async fn dropbox_delete_item(
    access_token: String,
    path: String,
) -> Result<(), String> {
    let body = format!(r#"{{"path":"{}"}}"#, path.replace('"', "\\\""));
    let client = crate::http_client::client();
    let resp = client
        .post(&format!("{}/files/delete_v2", RPC_BASE))
        .bearer_auth(&access_token)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("削除リクエスト失敗: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("削除失敗 ({}): {}", status, body));
    }
    Ok(())
}

/// Dropbox にフォルダを作成する。
#[tauri::command]
pub async fn dropbox_create_folder(
    access_token: String,
    parent_path: String,
    name: String,
) -> Result<DropboxEntry, String> {
    let new_path = if parent_path.is_empty() {
        format!("/{}", name)
    } else {
        format!("{}/{}", parent_path.trim_end_matches('/'), name)
    };

    let body = format!(r#"{{"path":"{}","autorename":false}}"#, new_path.replace('"', "\\\""));
    let client = crate::http_client::client();
    let resp = client
        .post(&format!("{}/files/create_folder_v2", RPC_BASE))
        .bearer_auth(&access_token)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("フォルダ作成リクエスト失敗: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("フォルダ作成失敗 ({}): {}", status, body));
    }

    let data: CreateFolderResponse = resp.json().await.map_err(|e| format!("レスポンス解析失敗: {}", e))?;
    let item = data.metadata;
    let path_display = item.path_display.clone().unwrap_or(new_path);
    Ok(DropboxEntry {
        id: item.id,
        name: item.name,
        is_dir: true,
        size: 0,
        modified: None,
        path_display,
    })
}
