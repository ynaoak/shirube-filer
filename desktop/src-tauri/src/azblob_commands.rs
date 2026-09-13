use crate::progress::CancelState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;

// ── Public types (returned to frontend) ─────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AzblobEntry {
    /// フルの blob 名（プレフィックス込み）。ダウンロード/削除に使う。
    pub key: String,
    /// 末尾のファイル/フォルダ名のみ。
    pub name: String,
    /// 仮想ディレクトリ（BlobPrefix）か。
    pub is_prefix: bool,
    pub size: u64,
    pub last_modified: Option<u64>,
}

// ── List Blobs の XML 構造（quick-xml serde） ────────────────────────────────

#[derive(Debug, Deserialize)]
struct EnumerationResults {
    #[serde(rename = "Blobs", default)]
    blobs: Blobs,
    #[serde(rename = "NextMarker", default)]
    next_marker: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Blobs {
    #[serde(rename = "Blob", default)]
    blob: Vec<Blob>,
    #[serde(rename = "BlobPrefix", default)]
    blob_prefix: Vec<BlobPrefix>,
}

#[derive(Debug, Deserialize)]
struct Blob {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Properties")]
    properties: BlobProperties,
}

#[derive(Debug, Deserialize)]
struct BlobProperties {
    #[serde(rename = "Content-Length", default)]
    content_length: Option<u64>,
    #[serde(rename = "Last-Modified", default)]
    last_modified: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BlobPrefix {
    #[serde(rename = "Name")]
    name: String,
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// `https://<account>.blob.core.windows.net`（endpoint 指定があればそちらを優先）。
fn account_base(account: &str, endpoint: Option<&str>) -> String {
    match endpoint.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(ep) => ep.trim_end_matches('/').to_string(),
        None => format!("https://{}.blob.core.windows.net", account),
    }
}

/// SAS 入力を正規化して純粋な SAS クエリ文字列にする。
/// - SAS URL 全体（`https://...?sv=...`）が貼り付けられた場合はクエリ部分のみを使う
/// - 先頭の `?` / `&` を除去
/// - `restype=container` や `comp=list` などリソース操作用のクエリが混入していると、
///   一覧（GET）は通るのに Put Blob が 400 InvalidUri で失敗するため、
///   SAS と無関係なパラメータを取り除く
fn normalize_sas(sas: &str) -> String {
    let s = sas.trim();
    let s = match (s.contains("://"), s.find('?')) {
        (true, Some(i)) => &s[i + 1..],
        _ => s,
    };
    let s = s.trim_start_matches('?').trim_start_matches('&');
    const DROP: &[&str] = &[
        "restype", "comp", "prefix", "delimiter", "marker", "maxresults",
        "include", "timeout", "blockid", "blocklisttype", "snapshot", "versionid",
    ];
    s.split('&')
        .filter(|kv| !kv.is_empty())
        .filter(|kv| {
            let key = kv.split('=').next().unwrap_or("").to_ascii_lowercase();
            !DROP.contains(&key.as_str())
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// クエリ値用にパーセントエンコードする（英数字と一部記号以外を %XX）。
fn enc_query(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// blob 名（パス）用エンコード。`/` は区切りとして残す。
fn enc_path(s: &str) -> String {
    s.split('/').map(enc_query).collect::<Vec<_>>().join("/")
}

fn parse_http_date(s: &str) -> Option<u64> {
    httpdate::parse_http_date(s)
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
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
        Some("txt") | Some("md") | Some("log") => "text/plain",
        Some("xml") => "application/xml",
        Some("csv") => "text/csv",
        _ => "application/octet-stream",
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// コンテナ内の blob / 仮想プレフィックス一覧を取得する（区切り `/`・ページネーション対応）。
#[tauri::command]
pub async fn azblob_list_objects(
    account: String,
    container: String,
    sas_token: String,
    endpoint: Option<String>,
    prefix: String,
) -> Result<Vec<AzblobEntry>, String> {
    let base = account_base(&account, endpoint.as_deref());
    let sas = normalize_sas(&sas_token);
    let client = crate::http_client::client();

    let mut entries: Vec<AzblobEntry> = Vec::new();
    let mut marker: Option<String> = None;

    loop {
        let mut url = format!(
            "{}/{}?restype=container&comp=list&delimiter=%2F&prefix={}&{}",
            base,
            enc_query(&container),
            enc_query(&prefix),
            sas,
        );
        if let Some(m) = &marker {
            url.push_str(&format!("&marker={}", enc_query(m)));
        }

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("一覧取得リクエスト失敗: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("一覧取得エラー ({}): {}", status, body));
        }

        let text = resp
            .text()
            .await
            .map_err(|e| format!("レスポンス読み取り失敗: {}", e))?;
        let parsed: EnumerationResults = quick_xml::de::from_str(&text)
            .map_err(|e| format!("XML 解析失敗: {}", e))?;

        // 仮想ディレクトリ
        for bp in parsed.blobs.blob_prefix {
            let key = bp.name;
            let name = key
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&key)
                .to_string();
            entries.push(AzblobEntry {
                key,
                name,
                is_prefix: true,
                size: 0,
                last_modified: None,
            });
        }

        // blob
        for b in parsed.blobs.blob {
            // ディレクトリプレースホルダ（末尾 /）はスキップ
            if b.name.ends_with('/') {
                continue;
            }
            let name = b.name.rsplit('/').next().unwrap_or(&b.name).to_string();
            entries.push(AzblobEntry {
                key: b.name,
                name,
                is_prefix: false,
                size: b.properties.content_length.unwrap_or(0),
                last_modified: b.properties.last_modified.as_deref().and_then(parse_http_date),
            });
        }

        match parsed.next_marker {
            Some(m) if !m.is_empty() => marker = Some(m),
            _ => break,
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

/// blob をローカルにダウンロードする（ストリーミング・キャンセル対応）。
/// local_path がディレクトリの場合は blob 名のファイル名を使う。
#[tauri::command]
pub async fn azblob_download_object(
    account: String,
    container: String,
    sas_token: String,
    endpoint: Option<String>,
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

    let base = account_base(&account, endpoint.as_deref());
    let sas = normalize_sas(&sas_token);
    let url = format!("{}/{}/{}?{}", base, enc_query(&container), enc_path(&key), sas);

    let client = crate::http_client::client();
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("ダウンロードリクエスト失敗: {}", e))?;

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
        match resp.chunk().await.map_err(|e| format!("ダウンロード中エラー: {}", e))? {
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

/// ローカルファイルを blob にアップロードする（ブロック blob・キャンセル対応）。
/// key が '/' で終わる場合はローカルのファイル名を付加する。
#[tauri::command]
pub async fn azblob_upload_object(
    account: String,
    container: String,
    sas_token: String,
    endpoint: Option<String>,
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

    let bytes = tokio::fs::read(&local_path)
        .await
        .map_err(|e| format!("ファイル読み込み失敗 ({}): {}", local_path, e))?;

    if flag.load(Ordering::Relaxed) {
        cancel.end();
        return Err("キャンセルされました".to_string());
    }

    let base = account_base(&account, endpoint.as_deref());
    let sas = normalize_sas(&sas_token);
    let url = format!("{}/{}/{}?{}", base, enc_query(&container), enc_path(&dest_key), sas);

    let client = crate::http_client::client();
    let resp = client
        .put(&url)
        .header("x-ms-blob-type", "BlockBlob")
        .header("Content-Type", guess_content_type(&filename))
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("アップロードリクエスト失敗: {}", e))?;

    cancel.end();

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("アップロード失敗 {} ({}): {}", dest_key, status, body));
    }

    Ok(())
}

/// blob を削除する。
#[tauri::command]
pub async fn azblob_delete_object(
    account: String,
    container: String,
    sas_token: String,
    endpoint: Option<String>,
    key: String,
) -> Result<(), String> {
    let base = account_base(&account, endpoint.as_deref());
    let sas = normalize_sas(&sas_token);
    let url = format!("{}/{}/{}?{}", base, enc_query(&container), enc_path(&key), sas);

    let client = crate::http_client::client();
    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| format!("削除リクエスト失敗: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("削除失敗 {} ({}): {}", key, status, body));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_sas;

    #[test]
    fn normalize_sas_plain_and_leading_marks() {
        assert_eq!(normalize_sas("sv=2024&sp=racwdl&sig=abc"), "sv=2024&sp=racwdl&sig=abc");
        assert_eq!(normalize_sas("?sv=2024&sig=abc"), "sv=2024&sig=abc");
        assert_eq!(normalize_sas("  &sv=2024&sig=abc "), "sv=2024&sig=abc");
    }

    #[test]
    fn normalize_sas_accepts_full_sas_url() {
        assert_eq!(
            normalize_sas("https://acct.blob.core.windows.net/test?sp=racwdl&sig=abc"),
            "sp=racwdl&sig=abc"
        );
    }

    #[test]
    fn normalize_sas_drops_resource_operation_params() {
        assert_eq!(
            normalize_sas("restype=container&comp=list&sv=2024&sig=abc"),
            "sv=2024&sig=abc"
        );
        assert_eq!(
            normalize_sas("sv=2024&sig=abc&restype=container"),
            "sv=2024&sig=abc"
        );
    }
}
