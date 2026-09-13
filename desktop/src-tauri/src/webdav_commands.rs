use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WebDavEntry {
    pub name: String,
    pub href: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

/// Decode percent-encoded URL path bytes (ASCII only; non-ASCII stays as-is).
fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = from_hex(bytes[i + 1]);
            let l = from_hex(bytes[i + 2]);
            if let (Some(h), Some(l)) = (h, l) {
                result.push(char::from(h << 4 | l));
                i += 3;
                continue;
            }
        }
        result.push(char::from(bytes[i]));
        i += 1;
    }
    result
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Extract the URL path component (everything after "scheme://host").
fn url_path(url: &str) -> &str {
    if let Some(idx) = url.find("://") {
        let after_scheme = &url[idx + 3..];
        if let Some(slash) = after_scheme.find('/') {
            return &after_scheme[slash..];
        }
        return "";
    }
    url
}

/// Parse HTTP date string ("Thu, 01 Jan 2024 00:00:00 GMT") into Unix timestamp.
fn parse_http_date(s: &str) -> Option<u64> {
    use std::time::SystemTime;
    httpdate::parse_http_date(s)
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Parse WebDAV PROPFIND multi-status XML response.
fn parse_propfind(xml: &str) -> Vec<WebDavEntry> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut entries: Vec<WebDavEntry> = Vec::new();
    let mut reader = Reader::from_str(xml);

    let mut cur_href = String::new();
    let mut cur_displayname = String::new();
    let mut cur_size: u64 = 0;
    let mut cur_modified: Option<u64> = None;
    let mut cur_is_collection = false;
    let mut in_response = false;
    let mut tag_stack: Vec<String> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let local = e.local_name();
                let name = std::str::from_utf8(local.as_ref())
                    .unwrap_or("")
                    .to_lowercase();
                if name == "response" {
                    in_response = true;
                    cur_href.clear();
                    cur_displayname.clear();
                    cur_size = 0;
                    cur_modified = None;
                    cur_is_collection = false;
                }
                tag_stack.push(name);
            }
            Ok(Event::Empty(e)) => {
                let local = e.local_name();
                let name = std::str::from_utf8(local.as_ref())
                    .unwrap_or("")
                    .to_lowercase();
                // <collection/> indicates a directory resource type
                if name == "collection" {
                    cur_is_collection = true;
                }
            }
            Ok(Event::Text(e)) => {
                if !in_response {
                    continue;
                }
                let text = match e.unescape() {
                    Ok(t) => t.trim().to_string(),
                    Err(_) => continue,
                };
                if text.is_empty() {
                    continue;
                }
                if let Some(parent) = tag_stack.last() {
                    match parent.as_str() {
                        "href" => cur_href = text,
                        "displayname" => cur_displayname = text,
                        "getcontentlength" => cur_size = text.parse().unwrap_or(0),
                        "getlastmodified" => cur_modified = parse_http_date(&text),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let local = e.local_name();
                let name = std::str::from_utf8(local.as_ref())
                    .unwrap_or("")
                    .to_lowercase();
                tag_stack.pop();
                if name == "response" && in_response {
                    if !cur_href.is_empty() {
                        let decoded = percent_decode(&cur_href);
                        let entry_name = if !cur_displayname.is_empty() {
                            cur_displayname.clone()
                        } else {
                            decoded
                                .trim_end_matches('/')
                                .rsplit('/')
                                .next()
                                .unwrap_or(&decoded)
                                .to_string()
                        };
                        if !entry_name.is_empty() {
                            entries.push(WebDavEntry {
                                name: entry_name,
                                href: cur_href.clone(),
                                is_dir: cur_is_collection,
                                size: cur_size,
                                modified: cur_modified,
                            });
                        }
                    }
                    in_response = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    entries
}

fn build_client() -> Result<Client, String> {
    // タイムアウト無しだとネットワーク異常時にリクエストが永遠に完了せず
    // UI がローディングのまま固まるため、共有クライアントと同じ値を設定する。
    Client::builder()
        .danger_accept_invalid_certs(false)
        .connect_timeout(crate::http_client::CONNECT_TIMEOUT)
        .timeout(crate::http_client::REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn webdav_list_dir(
    url: String,
    username: String,
    password: String,
) -> Result<Vec<WebDavEntry>, String> {
    let client = build_client()?;

    let propfind_body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>"#;

    let resp = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?,
            &url,
        )
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .basic_auth(&username, Some(&password))
        .body(propfind_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    // 207 Multi-Status is the expected success code for PROPFIND
    if status != reqwest::StatusCode::MULTI_STATUS && !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("")));
    }

    let xml = resp.text().await.map_err(|e| e.to_string())?;
    let mut entries = parse_propfind(&xml);

    // Remove the directory itself from the listing.
    // href はサーバーによってフル URL（"https://host/dav/sync/"）またはパスのみ
    // （"/dav/sync/"）が返るため、パス部分のみで比較する。
    // また % エスケープを含む場合があるのでデコードして比較する。
    let req_path = percent_decode(url_path(&url)).trim_end_matches('/').to_string();
    entries.retain(|e| {
        let href_path = url_path(&e.href);
        let normalized = percent_decode(href_path);
        normalized.trim_end_matches('/') != req_path
    });

    // Dirs first, then alphabetical
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn webdav_download(
    url: String,
    username: String,
    password: String,
    local_dir: String,
    filename: String,
) -> Result<(), String> {
    let client = build_client()?;

    let resp = client
        .get(&url)
        .basic_auth(&username, Some(&password))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let dest = Path::new(&local_dir).join(&filename);
    fs::write(&dest, &bytes).await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn webdav_upload(
    url: String,
    username: String,
    password: String,
    local_path: String,
) -> Result<(), String> {
    let client = build_client()?;
    let data = fs::read(&local_path).await.map_err(|e| e.to_string())?;

    let resp = client
        .put(&url)
        .basic_auth(&username, Some(&password))
        .body(data)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    Ok(())
}

#[tauri::command]
pub async fn webdav_delete(
    url: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let client = build_client()?;

    let resp = client
        .delete(&url)
        .basic_auth(&username, Some(&password))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    Ok(())
}

#[tauri::command]
pub async fn webdav_mkdir(
    url: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let client = build_client()?;

    let resp = client
        .request(
            reqwest::Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?,
            &url,
        )
        .basic_auth(&username, Some(&password))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    Ok(())
}
