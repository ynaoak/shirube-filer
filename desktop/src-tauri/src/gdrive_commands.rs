use crate::oauth_state::{
    generate_code_challenge, generate_code_verifier, url_encode, wait_for_loopback_oauth_code,
    OAuthDispatcher,
};
use crate::progress::CancelState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GDriveTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GDriveEntry {
    pub id: String,
    pub name: String,
    pub is_dir: bool,
    pub is_google_doc: bool, // Google Workspace ファイル（直接ダウンロード不可）
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
struct FileListResponse {
    files: Vec<DriveFile>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct DriveFile {
    id: String,
    name: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
    size: Option<String>, // Drive API returns size as string
    #[serde(rename = "modifiedTime")]
    modified_time: Option<String>,
}

#[derive(Deserialize)]
struct CreatedFile {
    id: String,
    name: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

// ── OAuth config ─────────────────────────────────────────────────────────────

const OAUTH_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/drive";

/// 登録手順: Google Cloud Console で「デスクトップアプリ」タイプの OAuth 2.0 クライアント ID を作成し、
/// 動的な loopback URI を使うため、カスタム URI の登録は不要です。
/// ビルド時に環境変数 `SHIRUBE_GDRIVE_CLIENT_ID` が設定されていればそちらを優先します
/// （未設定なら下記のプレースホルダにフォールバック）。
const BUNDLED_CLIENT_ID: &str = match option_env!("SHIRUBE_GDRIVE_CLIENT_ID") {
    Some(v) => v,
    None => "REPLACE_WITH_GDRIVE_CLIENT_ID.apps.googleusercontent.com",
};

const SERVICE_KEY: &str = "gdrive";
const API_BASE: &str = "https://www.googleapis.com/drive/v3";
const MIME_FOLDER: &str = "application/vnd.google-apps.folder";
const MIME_GDOC_PREFIX: &str = "application/vnd.google-apps.";

// ── Tauri commands ────────────────────────────────────────────────────────────

/// OAuth 2.0 PKCE フローを開始し、Google Drive の認証トークンを取得する。
#[tauri::command]
pub async fn gdrive_start_oauth_flow(
    dispatcher: tauri::State<'_, OAuthDispatcher>,
) -> Result<GDriveTokens, String> {
    let code_verifier = generate_code_verifier();
    let code_challenge = generate_code_challenge(&code_verifier);
    let oauth_state = generate_code_verifier();

    let (code, redirect_uri) = wait_for_loopback_oauth_code(
        &dispatcher,
        SERVICE_KEY,
        &oauth_state,
        |redirect_uri| {
            format!(
                "{}?client_id={}&redirect_uri={}&response_type=code&scope={}\
                 &code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
                OAUTH_AUTH_URL,
                url_encode(BUNDLED_CLIENT_ID),
                url_encode(redirect_uri),
                url_encode(OAUTH_SCOPE),
                url_encode(&code_challenge),
                url_encode(&oauth_state),
            )
        },
    )
    .await?;

    let client = crate::http_client::client();
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", BUNDLED_CLIENT_ID),
            ("code", code.as_str()),
            ("code_verifier", code_verifier.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
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

    Ok(GDriveTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// refresh_token を使って新しい access_token を取得する。
#[tauri::command]
pub async fn gdrive_refresh_access_token(
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

/// フォルダ内のファイル・サブフォルダ一覧を取得する（ページネーション対応）。
/// folder_id に "root" を指定すると My Drive のルートを取得する。
#[tauri::command]
pub async fn gdrive_list_files(
    access_token: String,
    folder_id: String,
) -> Result<Vec<GDriveEntry>, String> {
    let client = crate::http_client::client();
    let mut entries: Vec<GDriveEntry> = Vec::new();
    let mut page_token: Option<String> = None;
    let q = format!("'{}' in parents and trashed=false", folder_id);
    let fields = "files(id,name,mimeType,size,modifiedTime),nextPageToken";

    loop {
        let mut url = format!(
            "{}/files?q={}&fields={}&orderBy=folder,name&pageSize=1000",
            API_BASE,
            url_encode(&q),
            url_encode(fields),
        );
        if let Some(tok) = &page_token {
            url.push_str(&format!("&pageToken={}", url_encode(tok)));
        }

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

        let data: FileListResponse = resp
            .json()
            .await
            .map_err(|e| format!("レスポンス解析失敗: {}", e))?;

        for f in data.files {
            let is_dir = f.mime_type == MIME_FOLDER;
            let is_google_doc = !is_dir && f.mime_type.starts_with(MIME_GDOC_PREFIX);
            let size = f.size.as_deref().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            entries.push(GDriveEntry {
                id: f.id,
                name: f.name,
                is_dir,
                is_google_doc,
                size,
                modified: f.modified_time,
                mime_type: Some(f.mime_type),
            });
        }

        match data.next_page_token {
            Some(tok) => page_token = Some(tok),
            None => break,
        }
    }

    Ok(entries)
}

/// Google Drive ファイルをローカルにダウンロードする（ストリーミング・キャンセル対応）。
/// Google Workspace ドキュメントは PDF としてエクスポートする。
#[tauri::command]
pub async fn gdrive_download_file(
    access_token: String,
    file_id: String,
    file_name: String,
    mime_type: String,
    local_path: String,
    cancel: tauri::State<'_, CancelState>,
) -> Result<(), String> {
    let flag = cancel.begin();

    let local = std::path::Path::new(&local_path);
    let is_google_doc = mime_type.starts_with(MIME_GDOC_PREFIX);

    // ダウンロードファイル名（Google Docs は .pdf に変換）
    let actual_name = if is_google_doc {
        format!("{}.pdf", file_name)
    } else {
        file_name.clone()
    };

    let dest = if local.is_dir() {
        local.join(&actual_name)
    } else {
        local.to_path_buf()
    };

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let url = if is_google_doc {
        format!(
            "{}/files/{}/export?mimeType=application%2Fpdf",
            API_BASE, url_encode(&file_id)
        )
    } else {
        format!("{}/files/{}?alt=media", API_BASE, url_encode(&file_id))
    };

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
        return Err(format!("ダウンロード失敗 {} ({}): {}", actual_name, status, body));
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
            Some(chunk) => {
                dest_file.write_all(&chunk).await.map_err(|e| format!("書き込みエラー: {}", e))?;
            }
            None => break,
        }
    }

    cancel.end();
    Ok(())
}

/// ローカルファイルを Google Drive にアップロードする（resumable upload）。
#[tauri::command]
pub async fn gdrive_upload_file(
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

    let content_type = guess_content_type(&filename);
    let client = crate::http_client::client();

    // 1. resumable セッション開始
    let metadata = format!(
        r#"{{"name":"{}","parents":["{}"]}}"#,
        filename.replace('"', "\\\""),
        folder_id
    );

    let init_resp = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(&access_token)
        .header("X-Upload-Content-Type", content_type)
        .header("X-Upload-Content-Length", file_size.to_string())
        .header("Content-Type", "application/json; charset=UTF-8")
        .body(metadata)
        .send()
        .await
        .map_err(|e| format!("アップロードセッション開始失敗: {}", e))?;

    if !init_resp.status().is_success() {
        let status = init_resp.status();
        let body = init_resp.text().await.unwrap_or_default();
        cancel.end();
        return Err(format!("アップロードセッション開始エラー ({}): {}", status, body));
    }

    let session_uri = init_resp
        .headers()
        .get("location")
        .ok_or_else(|| "セッション URI が取得できません".to_string())?
        .to_str()
        .map_err(|_| "セッション URI が不正です".to_string())?
        .to_string();

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    // 2. ファイルをストリーミングアップロード
    let file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("ファイルオープン失敗: {}", e))?;

    let upload_resp = client
        .put(&session_uri)
        .header("Content-Length", file_size.to_string())
        .header("Content-Type", content_type)
        .body(reqwest::Body::from(file))
        .send()
        .await
        .map_err(|e| format!("アップロード失敗 ({}): {}", filename, e))?;

    cancel.end();

    if !upload_resp.status().is_success() {
        let status = upload_resp.status();
        let body = upload_resp.text().await.unwrap_or_default();
        return Err(format!("アップロードエラー {} ({}): {}", filename, status, body));
    }

    Ok(())
}

/// Google Drive ファイル/フォルダを削除する（ゴミ箱へ移動）。
#[tauri::command]
pub async fn gdrive_delete_file(
    access_token: String,
    file_id: String,
) -> Result<(), String> {
    let client = crate::http_client::client();
    // Drive API の DELETE はゴミ箱ではなく完全削除。PATCH でゴミ箱へ移動する。
    let url = format!("{}/files/{}", API_BASE, url_encode(&file_id));
    let resp = client
        .patch(&url)
        .bearer_auth(&access_token)
        .header("Content-Type", "application/json")
        .body(r#"{"trashed":true}"#)
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

/// Google Drive にフォルダを作成する。
#[tauri::command]
pub async fn gdrive_create_folder(
    access_token: String,
    parent_id: String,
    name: String,
) -> Result<GDriveEntry, String> {
    let client = crate::http_client::client();
    let body = format!(
        r#"{{"name":"{}","mimeType":"{}","parents":["{}"]}}"#,
        name.replace('"', "\\\""),
        MIME_FOLDER,
        parent_id,
    );

    let resp = client
        .post(&format!("{}/files", API_BASE))
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

    let f: CreatedFile = resp.json().await.map_err(|e| format!("レスポンス解析失敗: {}", e))?;
    Ok(GDriveEntry {
        id: f.id,
        name: f.name,
        is_dir: true,
        is_google_doc: false,
        size: 0,
        modified: None,
        mime_type: Some(f.mime_type),
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
