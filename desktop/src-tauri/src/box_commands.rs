use crate::oauth_state::{url_encode, wait_for_oauth_code, OAuthDispatcher};
use crate::progress::CancelState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoxTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoxEntry {
    pub id: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_at: Option<String>,
}

// ── Internal serde types ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct FolderItemsResponse {
    entries: Vec<BoxItem>,
    total_count: u64,
    limit: u64,
}

#[derive(Deserialize)]
struct BoxItem {
    id: String,
    #[serde(rename = "type")]
    item_type: String,
    name: String,
    size: Option<u64>,
    modified_at: Option<String>,
}

// ── OAuth config ─────────────────────────────────────────────────────────────

const OAUTH_AUTH_URL: &str = "https://account.box.com/api/oauth2/authorize";
const OAUTH_TOKEN_URL: &str = "https://api.box.com/oauth2/token";

/// 登録手順: Box Developer Console で「Custom App（OAuth 2.0 User Authentication）」を作成し、
/// リダイレクト URI に `https://shirube-filer.ynaoak.dev/oauth/box` を追加し、アプリの client_id をここに設定してください。
/// ビルド時に環境変数 `SHIRUBE_BOX_CLIENT_ID` が設定されていればそちらを優先します
/// （未設定なら下記のプレースホルダにフォールバック）。
const BUNDLED_CLIENT_ID: &str = match option_env!("SHIRUBE_BOX_CLIENT_ID") {
    Some(v) => v,
    None => "REPLACE_WITH_BOX_CLIENT_ID",
};

/// Box は OAuth 2.0 の PKCE（code_verifier）をサポートしておらず、
/// トークン交換（authorization_code / refresh_token）には client_secret が必須。
/// client_secret なしだと `invalid_client: The client credentials are invalid` (400) になる。
/// ビルド時に環境変数 `SHIRUBE_BOX_CLIENT_SECRET` を設定すること
/// （Box Developer Console の Configuration タブ > OAuth 2.0 Credentials）。
const BUNDLED_CLIENT_SECRET: &str = match option_env!("SHIRUBE_BOX_CLIENT_SECRET") {
    Some(v) => v,
    None => "REPLACE_WITH_BOX_CLIENT_SECRET",
};

/// Box のリダイレクト URI は HTTPS 必須（カスタムスキームは登録不可）のため、
/// Web サイトの中継ページ（apps/web/src/pages/oauth/[service].astro）でクエリをそのまま
/// `shirube-filer://oauth/box` ディープリンクへ転送してアプリに戻す。
/// ビルド時に環境変数 `SHIRUBE_BOX_REDIRECT_URI` が設定されていればそちらを優先する。
///
/// ここを変えたら Box Developer Console 側の登録リダイレクト URI も同じ値に更新すること。
/// 両者が一致しないと認可時に `redirect_uri_mismatch` で弾かれる。
const REDIRECT_URI: &str = match option_env!("SHIRUBE_BOX_REDIRECT_URI") {
    Some(v) => v,
    None => "https://shirube-filer.ynaoak.dev/oauth/box",
};
const SERVICE_KEY: &str = "box";
const API_BASE: &str = "https://api.box.com/2.0";
const UPLOAD_BASE: &str = "https://upload.box.com/api/2.0";

// ── Tauri commands ────────────────────────────────────────────────────────────

/// OAuth 2.0 認可コードフローを開始し、Box の認証トークンを取得する。
/// Box は PKCE 非対応のため、トークン交換は client_id + client_secret で行う。
#[tauri::command]
pub async fn box_start_oauth_flow(
    dispatcher: tauri::State<'_, OAuthDispatcher>,
) -> Result<BoxTokens, String> {
    if BUNDLED_CLIENT_SECRET.starts_with("REPLACE_WITH_") {
        return Err(
            "Box の client_secret が設定されていません。ビルド時に環境変数 \
             SHIRUBE_BOX_CLIENT_SECRET を設定して再ビルドしてください \
             （apps/desktop/docs/todo-developer.md の Box セクション参照）。"
                .to_string(),
        );
    }

    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code",
        OAUTH_AUTH_URL,
        url_encode(BUNDLED_CLIENT_ID),
        url_encode(REDIRECT_URI),
    );

    let code = wait_for_oauth_code(&dispatcher, SERVICE_KEY, &auth_url).await?;

    let client = crate::http_client::client();
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", BUNDLED_CLIENT_ID),
            ("client_secret", BUNDLED_CLIENT_SECRET),
            ("code", code.as_str()),
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

    Ok(BoxTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// refresh_token を使って新しいトークンペアを取得する。
/// Box は refresh のたびに新しい refresh_token を発行するので両方返す。
#[tauri::command]
pub async fn box_refresh_access_token(
    refresh_token: String,
) -> Result<BoxTokens, String> {
    let client = crate::http_client::client();
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", BUNDLED_CLIENT_ID),
            ("client_secret", BUNDLED_CLIENT_SECRET),
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

    let tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("レスポンス解析失敗: {}", e))?;

    Ok(BoxTokens {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// フォルダ内のアイテム一覧を取得する（オフセットページネーション対応）。
#[tauri::command]
pub async fn box_list_folder(
    access_token: String,
    folder_id: String,
) -> Result<Vec<BoxEntry>, String> {
    let client = crate::http_client::client();
    let mut entries: Vec<BoxEntry> = Vec::new();
    let mut offset: u64 = 0;
    let limit: u64 = 1000;
    let fields = "id,type,name,size,modified_at";

    loop {
        let url = format!(
            "{}/folders/{}/items?fields={}&limit={}&offset={}",
            API_BASE, url_encode(&folder_id), fields, limit, offset
        );

        let resp = client
            .get(&url)
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| format!("フォルダ一覧取得失敗: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("フォルダ一覧取得エラー ({}): {}", status, body));
        }

        let data: FolderItemsResponse = resp
            .json()
            .await
            .map_err(|e| format!("レスポンス解析失敗: {}", e))?;

        for item in data.entries {
            let is_dir = item.item_type == "folder";
            entries.push(BoxEntry {
                id: item.id,
                name: item.name,
                is_dir,
                size: item.size.unwrap_or(0),
                modified_at: item.modified_at,
            });
        }

        let fetched = offset + data.limit;
        if fetched >= data.total_count {
            break;
        }
        offset = fetched;
    }

    // フォルダ優先・名前順
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Box ファイルをローカルにダウンロードする（ストリーミング・キャンセル対応）。
#[tauri::command]
pub async fn box_download_file(
    access_token: String,
    file_id: String,
    file_name: String,
    local_path: String,
    cancel: tauri::State<'_, CancelState>,
) -> Result<(), String> {
    let flag = cancel.begin();

    let local = std::path::Path::new(&local_path);
    let dest = if local.is_dir() {
        local.join(&file_name)
    } else {
        local.to_path_buf()
    };

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let url = format!("{}/files/{}/content", API_BASE, url_encode(&file_id));
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
            Some(chunk) => {
                dest_file.write_all(&chunk).await.map_err(|e| format!("書き込みエラー: {}", e))?;
            }
            None => break,
        }
    }

    cancel.end();
    Ok(())
}

/// ローカルファイルを Box にアップロードする（multipart/form-data）。
#[tauri::command]
pub async fn box_upload_file(
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

    let file_bytes = tokio::fs::read(&local_path)
        .await
        .map_err(|e| format!("ファイル読み込み失敗: {}", e))?;

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let attributes = format!(
        r#"{{"name":"{}","parent":{{"id":"{}"}}}}"#,
        filename.replace('"', "\\\""),
        folder_id,
    );

    let boundary = format!("----BoxUploadBoundary{}", std::process::id());
    let content_type_header = format!("multipart/form-data; boundary={}", boundary);

    // multipart ボディを手動構築
    let mut body = Vec::new();
    // attributes part
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"attributes\"\r\n");
    body.extend_from_slice(b"Content-Type: application/json\r\n\r\n");
    body.extend_from_slice(attributes.as_bytes());
    body.extend_from_slice(b"\r\n");
    // file part
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n",
            filename
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(&file_bytes);
    body.extend_from_slice(b"\r\n");
    // closing boundary
    body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());

    let client = crate::http_client::client();
    let upload_resp = client
        .post(&format!("{}/files/content", UPLOAD_BASE))
        .bearer_auth(&access_token)
        .header("Content-Type", content_type_header)
        .body(body)
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

/// Box ファイルまたはフォルダを削除する（ゴミ箱へ移動）。
#[tauri::command]
pub async fn box_delete_item(
    access_token: String,
    item_id: String,
    is_dir: bool,
) -> Result<(), String> {
    let kind = if is_dir { "folders" } else { "files" };
    let url = if is_dir {
        format!("{}/{}/{}?recursive=true", API_BASE, kind, url_encode(&item_id))
    } else {
        format!("{}/{}/{}", API_BASE, kind, url_encode(&item_id))
    };

    let client = crate::http_client::client();
    let resp = client
        .delete(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("削除リクエスト失敗: {}", e))?;

    if !resp.status().is_success() && resp.status().as_u16() != 204 {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("削除失敗 ({}): {}", status, body));
    }
    Ok(())
}

/// Box にフォルダを作成する。
#[tauri::command]
pub async fn box_create_folder(
    access_token: String,
    parent_id: String,
    name: String,
) -> Result<BoxEntry, String> {
    let body = format!(
        r#"{{"name":"{}","parent":{{"id":"{}"}}}}"#,
        name.replace('"', "\\\""),
        parent_id,
    );

    let client = crate::http_client::client();
    let resp = client
        .post(&format!("{}/folders", API_BASE))
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

    let item: BoxItem = resp.json().await.map_err(|e| format!("レスポンス解析失敗: {}", e))?;
    Ok(BoxEntry {
        id: item.id,
        name: item.name,
        is_dir: true,
        size: 0,
        modified_at: item.modified_at,
    })
}
