use aws_config::BehaviorVersion;
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::Client;
use crate::progress::CancelState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct S3Bucket {
    pub name: String,
    pub created: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct S3Entry {
    pub key: String,
    pub name: String,
    pub is_prefix: bool,
    pub size: u64,
    pub last_modified: Option<u64>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

async fn make_client(
    access_key: &str,
    secret_key: &str,
    region: &str,
    endpoint: Option<&str>,
) -> Client {
    let creds = Credentials::new(access_key, secret_key, None, None, "shirube-filer");
    // タイムアウト無しだとネットワーク異常時に操作が永遠に完了せず UI が固まる。
    let timeouts = aws_config::timeout::TimeoutConfig::builder()
        .connect_timeout(crate::http_client::CONNECT_TIMEOUT)
        .operation_timeout(crate::http_client::REQUEST_TIMEOUT)
        .build();
    let mut loader = aws_config::defaults(BehaviorVersion::latest())
        .credentials_provider(creds)
        .region(Region::new(region.to_owned()))
        .timeout_config(timeouts);

    if let Some(ep) = endpoint.filter(|s| !s.is_empty()) {
        loader = loader.endpoint_url(ep);
    }

    let sdk_config = loader.load().await;

    let s3_conf = aws_sdk_s3::config::Builder::from(&sdk_config)
        // MinIO / Cloudflare R2 / その他 S3 互換エンドポイント向け
        .force_path_style(true)
        .build();

    Client::from_conf(s3_conf)
}

fn dt_to_unix(dt: &aws_sdk_s3::primitives::DateTime) -> Option<u64> {
    let s = dt.secs();
    if s >= 0 { Some(s as u64) } else { None }
}

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

/// バケット一覧を取得する
#[tauri::command]
pub async fn s3_list_buckets(
    access_key: String,
    secret_key: String,
    region: String,
    endpoint: Option<String>,
) -> Result<Vec<S3Bucket>, String> {
    let client = make_client(&access_key, &secret_key, &region, endpoint.as_deref()).await;

    let resp = client
        .list_buckets()
        .send()
        .await
        .map_err(|e| format!("バケット一覧取得失敗: {}", e))?;

    let buckets = resp
        .buckets()
        .iter()
        .map(|b| S3Bucket {
            name: b.name().unwrap_or("").to_string(),
            created: b.creation_date().and_then(dt_to_unix),
        })
        .collect();

    Ok(buckets)
}

/// バケット内のオブジェクト / プレフィックス一覧を取得する（ページネーション対応）
#[tauri::command]
pub async fn s3_list_objects(
    access_key: String,
    secret_key: String,
    region: String,
    endpoint: Option<String>,
    bucket: String,
    prefix: String,
) -> Result<Vec<S3Entry>, String> {
    let client = make_client(&access_key, &secret_key, &region, endpoint.as_deref()).await;

    let mut entries: Vec<S3Entry> = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
        let mut req = client
            .list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix)
            .delimiter("/");

        if let Some(token) = continuation_token.take() {
            req = req.continuation_token(token);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("オブジェクト一覧取得失敗: {}", e))?;

        // 共通プレフィックス（仮想ディレクトリ）
        for cp in resp.common_prefixes() {
            let key = cp.prefix().unwrap_or("").to_string();
            let name = key
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&key)
                .to_string();
            entries.push(S3Entry {
                key,
                name,
                is_prefix: true,
                size: 0,
                last_modified: None,
                etag: None,
                storage_class: None,
            });
        }

        // オブジェクト
        for obj in resp.contents() {
            let key = obj.key().unwrap_or("").to_string();
            // ディレクトリプレースホルダーをスキップ
            if key == prefix || key.ends_with('/') {
                continue;
            }
            let name = key.rsplit('/').next().unwrap_or(&key).to_string();
            entries.push(S3Entry {
                key,
                name,
                is_prefix: false,
                size: obj.size().unwrap_or(0) as u64,
                last_modified: obj.last_modified().and_then(dt_to_unix),
                etag: obj.e_tag().map(|s| s.trim_matches('"').to_string()),
                storage_class: obj.storage_class().map(|sc| sc.as_str().to_string()),
            });
        }

        if resp.is_truncated().unwrap_or(false) {
            continuation_token = resp.next_continuation_token().map(|s| s.to_string());
        } else {
            break;
        }
    }

    // ディレクトリ優先・名前順
    entries.sort_by(|a, b| {
        b.is_prefix
            .cmp(&a.is_prefix)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// オブジェクトをローカルにダウンロードする（ストリーミング・キャンセル対応）
/// local_path がディレクトリの場合はオブジェクトキーのファイル名を使用する
#[tauri::command]
pub async fn s3_download_object(
    access_key: String,
    secret_key: String,
    region: String,
    endpoint: Option<String>,
    bucket: String,
    key: String,
    local_path: String,
    cancel: tauri::State<'_, CancelState>,
) -> Result<(), String> {
    let flag = cancel.begin();

    let local = std::path::Path::new(&local_path);
    let dest = if local.is_dir() {
        let filename = std::path::Path::new(&key)
            .file_name()
            .ok_or_else(|| "キーからファイル名を取得できません".to_string())?;
        local.join(filename)
    } else {
        local.to_path_buf()
    };

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let client = make_client(&access_key, &secret_key, &region, endpoint.as_deref()).await;
    let resp = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("オブジェクト取得失敗 ({}): {}", key, e))?;

    let mut dest_file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("ファイル作成失敗 ({}): {}", dest.display(), e))?;

    // ストリーミングで書き込み（256 KB ごとにキャンセルチェック）
    let mut reader = resp.body.into_async_read();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if flag.load(Ordering::Relaxed) {
            drop(dest_file);
            tokio::fs::remove_file(&dest).await.ok();
            cancel.end();
            return Err("キャンセルされました".to_string());
        }
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| format!("ダウンロード中エラー: {}", e))?;
        if n == 0 {
            break;
        }
        dest_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("ファイル書き込みエラー: {}", e))?;
    }

    cancel.end();
    Ok(())
}

/// ローカルファイルを S3 にアップロードする（ストリーミング・キャンセル対応）
/// key が '/' で終わる場合はローカルのファイル名を付加する
#[tauri::command]
pub async fn s3_upload_object(
    access_key: String,
    secret_key: String,
    region: String,
    endpoint: Option<String>,
    bucket: String,
    key: String,
    local_path: String,
    cancel: tauri::State<'_, CancelState>,
) -> Result<(), String> {
    let flag = cancel.begin();

    let filename = std::path::Path::new(&local_path)
        .file_name()
        .ok_or_else(|| "ファイル名を取得できません".to_string())?
        .to_string_lossy()
        .to_string();

    let dest_key = if key.ends_with('/') {
        format!("{}{}", key, filename)
    } else {
        key.clone()
    };

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let content_type = guess_content_type(&filename);
    let body = aws_sdk_s3::primitives::ByteStream::from_path(std::path::Path::new(&local_path))
        .await
        .map_err(|e| format!("ファイルストリーム作成失敗 ({}): {}", local_path, e))?;

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let client = make_client(&access_key, &secret_key, &region, endpoint.as_deref()).await;
    client
        .put_object()
        .bucket(&bucket)
        .key(&dest_key)
        .body(body)
        .content_type(content_type)
        .send()
        .await
        .map_err(|e| format!("アップロード失敗 ({}): {}", dest_key, e))?;

    cancel.end();
    Ok(())
}

/// オブジェクトを削除する
#[tauri::command]
pub async fn s3_delete_object(
    access_key: String,
    secret_key: String,
    region: String,
    endpoint: Option<String>,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let client = make_client(&access_key, &secret_key, &region, endpoint.as_deref()).await;

    client
        .delete_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("削除失敗 ({}): {}", key, e))?;

    Ok(())
}
