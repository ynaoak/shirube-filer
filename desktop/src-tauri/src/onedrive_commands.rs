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
pub struct OneDriveTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveEntry {
    pub id: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub mime_type: Option<String>,
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
struct DriveItemList {
    value: Vec<DriveItem>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Deserialize)]
struct DriveItem {
    id: String,
    name: String,
    size: Option<u64>,
    #[serde(rename = "lastModifiedDateTime")]
    last_modified: Option<String>,
    file: Option<DriveFile>,
    folder: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct DriveFile {
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
}

#[derive(Deserialize)]
struct UploadSession {
    #[serde(rename = "uploadUrl")]
    upload_url: String,
}

// ── OAuth config ─────────────────────────────────────────────────────────────

const OAUTH_AUTH_URL: &str =
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const OAUTH_TOKEN_URL: &str =
    "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const OAUTH_SCOPE: &str = "files.readwrite offline_access";

/// 登録手順: Azure Portal で「モバイルおよびデスクトップ アプリケーション」タイプのアプリを登録し、
/// リダイレクト URI に `shirube-filer://oauth/onedrive` を追加して「アプリケーション (クライアント) ID」を設定してください。
/// パブリック クライアントであるためクライアントシークレットは不要です。
/// ビルド時に環境変数 `SHIRUBE_ONEDRIVE_CLIENT_ID` が設定されていればそちらを優先します
/// （未設定なら下記のプレースホルダにフォールバック）。
const BUNDLED_CLIENT_ID: &str = match option_env!("SHIRUBE_ONEDRIVE_CLIENT_ID") {
    Some(v) => v,
    None => "REPLACE_WITH_ONEDRIVE_CLIENT_ID",
};

const REDIRECT_URI: &str = "shirube-filer://oauth/onedrive";
const SERVICE_KEY: &str = "onedrive";
const API_BASE: &str = "https://graph.microsoft.com/v1.0";

// ── Tauri commands ────────────────────────────────────────────────────────────

/// OAuth 2.0 PKCE フローを開始し、OneDrive の認証トークンを取得する。
#[tauri::command]
pub async fn onedrive_start_oauth_flow(
    dispatcher: tauri::State<'_, OAuthDispatcher>,
) -> Result<OneDriveTokens, String> {
    let code_verifier = generate_code_verifier();
    let code_challenge = generate_code_challenge(&code_verifier);

    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &code_challenge={}&code_challenge_method=S256",
        OAUTH_AUTH_URL,
        url_encode(BUNDLED_CLIENT_ID),
        url_encode(REDIRECT_URI),
        url_encode(OAUTH_SCOPE),
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
            ("scope", OAUTH_SCOPE),
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

    Ok(OneDriveTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// refresh_token を使って新しい access_token を取得する。
#[tauri::command]
pub async fn onedrive_refresh_access_token(
    refresh_token: String,
) -> Result<String, String> {
    let client = crate::http_client::client();
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", BUNDLED_CLIENT_ID),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
            ("scope", OAUTH_SCOPE),
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
/// folder_id に "root" を指定すると OneDrive のルートを取得する。
#[tauri::command]
pub async fn onedrive_list_files(
    access_token: String,
    folder_id: String,
) -> Result<Vec<OneDriveEntry>, String> {
    let client = crate::http_client::client();
    let mut entries: Vec<OneDriveEntry> = Vec::new();
    let select = "$select=id,name,file,folder,size,lastModifiedDateTime";

    let first_url = if folder_id == "root" {
        format!("{}/me/drive/root/children?{}&$top=1000", API_BASE, select)
    } else {
        format!("{}/me/drive/items/{}/children?{}&$top=1000", API_BASE, url_encode(&folder_id), select)
    };
    let mut url = first_url;

    loop {
        let resp = client
            .get(&url)
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| format!("ファイル一覧取得失敗: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("ファイル一覧取得エラー ({}): {}", status, body));
        }

        let data: DriveItemList = resp
            .json()
            .await
            .map_err(|e| format!("レスポンス解析失敗: {}", e))?;

        for item in data.value {
            let is_dir = item.folder.is_some();
            let mime_type = item.file.as_ref().and_then(|f| f.mime_type.clone());
            entries.push(OneDriveEntry {
                id: item.id,
                name: item.name,
                is_dir,
                size: item.size.unwrap_or(0),
                modified: item.last_modified,
                mime_type,
            });
        }

        match data.next_link {
            Some(next) => url = next,
            None => break,
        }
    }

    // フォルダ優先・名前順
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// OneDrive ファイルをローカルにダウンロードする（ストリーミング・キャンセル対応）。
#[tauri::command]
pub async fn onedrive_download_file(
    access_token: String,
    file_id: String,
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

    let url = format!("{}/me/drive/items/{}/content", API_BASE, url_encode(&file_id));
    let client = crate::http_client::client();
    let mut resp = client
        .get(&url)
        .bearer_auth(&access_token)
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

/// ローカルファイルを OneDrive にアップロードする（resumable upload、サイズ制限なし）。
#[tauri::command]
pub async fn onedrive_upload_file(
    access_token: String,
    folder_id: String,
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

    let meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("ファイル情報取得失敗: {}", e))?;
    let file_size = meta.len();

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let client = crate::http_client::client();
    let content_type = guess_content_type(&filename);

    // 4MB 以下はシンプルアップロード
    if file_size <= 4 * 1024 * 1024 {
        let upload_url = if folder_id == "root" {
            format!("{}/me/drive/root:/{}:/content", API_BASE, url_encode(&filename))
        } else {
            format!("{}/me/drive/items/{}/{}:/content", API_BASE, url_encode(&folder_id), url_encode(&filename))
        };

        let file = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| format!("ファイルオープン失敗: {}", e))?;

        let resp = client
            .put(&upload_url)
            .bearer_auth(&access_token)
            .header("Content-Type", content_type)
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

    // 4MB 超は resumable upload session
    let session_url = if folder_id == "root" {
        format!("{}/me/drive/root:/{}:/createUploadSession", API_BASE, url_encode(&filename))
    } else {
        format!(
            "{}/me/drive/items/{}/{}:/createUploadSession",
            API_BASE,
            url_encode(&folder_id),
            url_encode(&filename)
        )
    };

    let session_body = format!(
        r#"{{"item":{{"@microsoft.graph.conflictBehavior":"replace","name":"{}"}}}}"#,
        filename.replace('"', "\\\"")
    );

    let session_resp = client
        .post(&session_url)
        .bearer_auth(&access_token)
        .header("Content-Type", "application/json")
        .body(session_body)
        .send()
        .await
        .map_err(|e| format!("アップロードセッション開始失敗: {}", e))?;

    if !session_resp.status().is_success() {
        let status = session_resp.status();
        let body = session_resp.text().await.unwrap_or_default();
        cancel.end();
        return Err(format!("アップロードセッション開始エラー ({}): {}", status, body));
    }

    let session: UploadSession = session_resp
        .json()
        .await
        .map_err(|e| format!("セッションレスポンス解析失敗: {}", e))?;

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("ファイルオープン失敗: {}", e))?;

    let upload_resp = client
        .put(&session.upload_url)
        .header("Content-Length", file_size.to_string())
        .header("Content-Range", format!("bytes 0-{}/{}", file_size - 1, file_size))
        .header("Content-Type", content_type)
        .body(reqwest::Body::from(file))
        .send()
        .await
        .map_err(|e| format!("アップロード失敗 ({}): {}", filename, e))?;

    cancel.end();

    if !upload_resp.status().is_success() && upload_resp.status().as_u16() != 201 {
        let status = upload_resp.status();
        let body = upload_resp.text().await.unwrap_or_default();
        return Err(format!("アップロードエラー {} ({}): {}", filename, status, body));
    }

    Ok(())
}

/// OneDrive ファイル/フォルダを削除する（ゴミ箱へ移動）。
#[tauri::command]
pub async fn onedrive_delete_file(
    access_token: String,
    file_id: String,
) -> Result<(), String> {
    let url = format!("{}/me/drive/items/{}", API_BASE, url_encode(&file_id));
    let client = crate::http_client::client();
    let resp = client
        .delete(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("削除リクエスト失敗: {}", e))?;

    // 204 No Content が正常
    if !resp.status().is_success() && resp.status().as_u16() != 204 {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("削除失敗 ({}): {}", status, body));
    }
    Ok(())
}

/// OneDrive にフォルダを作成する。
#[tauri::command]
pub async fn onedrive_create_folder(
    access_token: String,
    parent_id: String,
    name: String,
) -> Result<OneDriveEntry, String> {
    let url = if parent_id == "root" {
        format!("{}/me/drive/root/children", API_BASE)
    } else {
        format!("{}/me/drive/items/{}/children", API_BASE, url_encode(&parent_id))
    };

    let body = format!(
        r#"{{"name":"{}","folder":{{}},"@microsoft.graph.conflictBehavior":"rename"}}"#,
        name.replace('"', "\\\"")
    );

    let client = crate::http_client::client();
    let resp = client
        .post(&url)
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

    let item: DriveItem = resp.json().await.map_err(|e| format!("レスポンス解析失敗: {}", e))?;
    Ok(OneDriveEntry {
        id: item.id,
        name: item.name,
        is_dir: true,
        size: 0,
        modified: item.last_modified,
        mime_type: None,
    })
}

// ── Content-Type guess ────────────────────────────────────────────────────────

fn guess_content_type(filename: &str) -> &'static str {
    match filename.rsplit('.').next().map(|s| s.to_lowercase()).as_deref() {
        Some("html") | Some("htm") => "text/html",
        Some("css") => "text/css",
        Some("js") | Some("mjs") => "application/javascript",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        Some("tar") => "application/x-tar",
        Some("gz") => "application/gzip",
        Some("txt") | Some("md") | Some("log") => "text/plain",
        Some("xml") => "application/xml",
        Some("csv") => "text/csv",
        _ => "application/octet-stream",
    }
}
