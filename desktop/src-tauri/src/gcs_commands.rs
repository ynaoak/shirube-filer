use crate::oauth_state::{
    generate_code_challenge, generate_code_verifier, url_encode, wait_for_oauth_code,
    OAuthDispatcher,
};
use crate::progress::CancelState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;

// ── Public types (returned to frontend) ─────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GcsTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GcsBucket {
    pub name: String,
    pub location: Option<String>,
    pub created: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GcsEntry {
    pub key: String,
    pub name: String,
    pub is_prefix: bool,
    pub size: u64,
    pub updated: Option<String>,
    pub content_type: Option<String>,
    pub storage_class: Option<String>,
}

// ── Internal serde types for GCS JSON API ───────────────────────────────────

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
struct BucketListResponse {
    items: Option<Vec<BucketItem>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct BucketItem {
    name: String,
    location: Option<String>,
    #[serde(rename = "timeCreated")]
    time_created: Option<String>,
}

#[derive(Deserialize)]
struct ObjectListResponse {
    items: Option<Vec<ObjectItem>>,
    prefixes: Option<Vec<String>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct ObjectItem {
    name: String,
    size: Option<String>, // GCS JSON API returns size as string
    updated: Option<String>,
    #[serde(rename = "contentType")]
    content_type: Option<String>,
    #[serde(rename = "storageClass")]
    storage_class: Option<String>,
}

// ── OAuth 2.0 config ─────────────────────────────────────────────────────────

const OAUTH_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/devstorage.full_control";

/// OAuth 2.0 クライアント ID（shirube-filer として Google に登録済み）。
///
/// 登録手順: Google Cloud Console で「デスクトップアプリ」タイプの OAuth 2.0 クライアント ID を作成し、
/// 承認済みリダイレクト URI に `shirube-filer://oauth/gcs` を追加して、この値を置き換えてください。
/// デスクトップアプリタイプではクライアントシークレットは不要です。
/// ビルド時に環境変数 `SHIRUBE_GCS_CLIENT_ID` が設定されていればそちらを優先します
/// （未設定なら下記のプレースホルダにフォールバック）。
const BUNDLED_CLIENT_ID: &str = match option_env!("SHIRUBE_GCS_CLIENT_ID") {
    Some(v) => v,
    None => "REPLACE_WITH_GCS_CLIENT_ID.apps.googleusercontent.com",
};

const REDIRECT_URI: &str = "shirube-filer://oauth/gcs";
const SERVICE_KEY: &str = "gcs";

// ── Tauri commands ────────────────────────────────────────────────────────────

/// OAuth 2.0 PKCE フローを開始し、ブラウザで Google 認証を行う。
/// OS のカスタム URI スキーム（shirube-filer://oauth/gcs）経由でコールバックを受信する。
#[tauri::command]
pub async fn gcs_start_oauth_flow(
    dispatcher: tauri::State<'_, OAuthDispatcher>,
) -> Result<GcsTokens, String> {
    let code_verifier = generate_code_verifier();
    let code_challenge = generate_code_challenge(&code_verifier);

    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
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

    Ok(GcsTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// refresh_token を使って新しい access_token を取得する。
#[tauri::command]
pub async fn gcs_refresh_access_token(
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

/// プロジェクト内のバケット一覧を取得する（ページネーション対応）。
#[tauri::command]
pub async fn gcs_list_buckets(
    access_token: String,
    project_id: String,
) -> Result<Vec<GcsBucket>, String> {
    let client = crate::http_client::client();
    let mut buckets: Vec<GcsBucket> = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut url = format!(
            "https://storage.googleapis.com/storage/v1/b?project={}&maxResults=250",
            url_encode(&project_id)
        );
        if let Some(tok) = &page_token {
            url.push_str(&format!("&pageToken={}", url_encode(tok)));
        }

        let resp = client
            .get(&url)
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| format!("バケット一覧取得失敗: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("バケット一覧取得エラー ({}): {}", status, body));
        }

        let data: BucketListResponse = resp
            .json()
            .await
            .map_err(|e| format!("バケットレスポンス解析失敗: {}", e))?;

        for b in data.items.unwrap_or_default() {
            buckets.push(GcsBucket {
                name: b.name,
                location: b.location,
                created: b.time_created,
            });
        }

        match data.next_page_token {
            Some(tok) => page_token = Some(tok),
            None => break,
        }
    }

    Ok(buckets)
}

/// バケット内のオブジェクト / 仮想プレフィックス一覧を取得する（ページネーション対応）。
#[tauri::command]
pub async fn gcs_list_objects(
    access_token: String,
    bucket: String,
    prefix: String,
) -> Result<Vec<GcsEntry>, String> {
    let client = crate::http_client::client();
    let mut entries: Vec<GcsEntry> = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut url = format!(
            "https://storage.googleapis.com/storage/v1/b/{}/o?delimiter=/&maxResults=1000",
            url_encode(&bucket)
        );
        if !prefix.is_empty() {
            url.push_str(&format!("&prefix={}", url_encode(&prefix)));
        }
        if let Some(tok) = &page_token {
            url.push_str(&format!("&pageToken={}", url_encode(tok)));
        }

        let resp = client
            .get(&url)
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| format!("オブジェクト一覧取得失敗: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("オブジェクト一覧取得エラー ({}): {}", status, body));
        }

        let data: ObjectListResponse = resp
            .json()
            .await
            .map_err(|e| format!("オブジェクトレスポンス解析失敗: {}", e))?;

        for p in data.prefixes.unwrap_or_default() {
            let name = p
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&p)
                .to_string();
            entries.push(GcsEntry {
                key: p,
                name,
                is_prefix: true,
                size: 0,
                updated: None,
                content_type: None,
                storage_class: None,
            });
        }

        for obj in data.items.unwrap_or_default() {
            if obj.name == prefix || obj.name.ends_with('/') {
                continue;
            }
            let name = obj.name.rsplit('/').next().unwrap_or(&obj.name).to_string();
            let size = obj
                .size
                .as_deref()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            entries.push(GcsEntry {
                key: obj.name,
                name,
                is_prefix: false,
                size,
                updated: obj.updated,
                content_type: obj.content_type,
                storage_class: obj.storage_class,
            });
        }

        match data.next_page_token {
            Some(tok) => page_token = Some(tok),
            None => break,
        }
    }

    entries.sort_by(|a, b| {
        b.is_prefix
            .cmp(&a.is_prefix)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// GCS オブジェクトをローカルにダウンロードする（ストリーミング・キャンセル対応）。
#[tauri::command]
pub async fn gcs_download_object(
    access_token: String,
    bucket: String,
    key: String,
    local_path: String,
    cancel: tauri::State<'_, CancelState>,
) -> Result<(), String> {
    let flag = cancel.begin();

    let local = std::path::Path::new(&local_path);
    let dest = if local.is_dir() {
        let fname = std::path::Path::new(&key)
            .file_name()
            .ok_or_else(|| "キーからファイル名を取得できません".to_string())?;
        local.join(fname)
    } else {
        local.to_path_buf()
    };

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let url = format!(
        "https://storage.googleapis.com/storage/v1/b/{}/o/{}?alt=media",
        url_encode(&bucket),
        url_encode(&key)
    );

    let client = crate::http_client::client();
    let mut resp = client
        .get(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("ダウンロードリクエスト失敗 ({}): {}", key, e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ダウンロード失敗 {} ({}): {}", key, status, body));
    }

    let mut dest_file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("ファイル作成失敗 ({}): {}", dest.display(), e))?;

    loop {
        if flag.load(Ordering::Relaxed) {
            drop(dest_file);
            tokio::fs::remove_file(&dest).await.ok();
            cancel.end();
            return Err("キャンセルされました".to_string());
        }
        match resp
            .chunk()
            .await
            .map_err(|e| format!("ダウンロード中エラー: {}", e))?
        {
            Some(chunk) => {
                dest_file
                    .write_all(&chunk)
                    .await
                    .map_err(|e| format!("ファイル書き込みエラー: {}", e))?;
            }
            None => break,
        }
    }

    cancel.end();
    Ok(())
}

/// ローカルファイルを GCS にアップロードする（resumable upload プロトコル）。
#[tauri::command]
pub async fn gcs_upload_object(
    access_token: String,
    bucket: String,
    prefix: String,
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

    let dest_key = if prefix.is_empty() {
        filename.clone()
    } else {
        format!("{}{}", prefix, filename)
    };

    let meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("ファイル情報取得失敗 ({}): {}", local_path, e))?;
    let file_size = meta.len();

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let content_type = guess_content_type(&filename);
    let client = crate::http_client::client();

    let initiate_url = format!(
        "https://storage.googleapis.com/upload/storage/v1/b/{}/o?uploadType=resumable&name={}",
        url_encode(&bucket),
        url_encode(&dest_key)
    );

    let init_resp = client
        .post(&initiate_url)
        .bearer_auth(&access_token)
        .header("X-Upload-Content-Type", content_type)
        .header("X-Upload-Content-Length", file_size.to_string())
        .header("Content-Type", "application/json")
        .header("Content-Length", "0")
        .body("")
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

    let file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("ファイルオープン失敗 ({}): {}", local_path, e))?;

    let upload_resp = client
        .put(&session_uri)
        .header("Content-Length", file_size.to_string())
        .body(reqwest::Body::from(file))
        .send()
        .await
        .map_err(|e| format!("アップロード失敗 ({}): {}", dest_key, e))?;

    cancel.end();

    if !upload_resp.status().is_success() {
        let status = upload_resp.status();
        let body = upload_resp.text().await.unwrap_or_default();
        return Err(format!("アップロードエラー {} ({}): {}", dest_key, status, body));
    }

    Ok(())
}

/// GCS オブジェクトを削除する。
#[tauri::command]
pub async fn gcs_delete_object(
    access_token: String,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let url = format!(
        "https://storage.googleapis.com/storage/v1/b/{}/o/{}",
        url_encode(&bucket),
        url_encode(&key)
    );

    let client = crate::http_client::client();
    let resp = client
        .delete(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("削除リクエスト失敗 ({}): {}", key, e))?;

    if !resp.status().is_success() && resp.status().as_u16() != 204 {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("削除失敗 {} ({}): {}", key, status, body));
    }

    Ok(())
}

// ── Content-Type ─────────────────────────────────────────────────────────────

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
