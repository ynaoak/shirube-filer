use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// ── Shared OAuth dispatcher ───────────────────────────────────────────────────

/// サービス名をキーとして OAuth 認証コードを受け渡す共有ディスパッチャ。
/// 各コマンドがセンダーを登録し、deep-link ハンドラが `deliver_oauth_code` でコードを送信する。
pub struct OAuthDispatcher(
    pub Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
);

impl Default for OAuthDispatcher {
    fn default() -> Self { Self(Mutex::new(HashMap::new())) }
}

/// deep-link URL を解析して対応するサービスにコードをルーティングする。
/// URL 形式: `shirube-filer://oauth/<service>?code=XXX` または `?error=...`
pub fn deliver_oauth_code(dispatcher: &OAuthDispatcher, url: &str) {
    let service = parse_service(url).unwrap_or_default();
    let result = if let Some(code) = parse_qs(url, "code") {
        Ok(code)
    } else if let Some(err) = parse_qs(url, "error") {
        Err(format!("OAuth 認証エラー: {}", err))
    } else {
        Err("コールバック URL に認証コードが含まれていません".to_string())
    };
    if let Ok(mut map) = dispatcher.0.lock() {
        if let Some(tx) = map.remove(&service) {
            let _ = tx.send(result);
        }
    }
}

/// 進行中の OAuth 待機をキャンセルする。
/// 待機中の `wait_for_oauth_code` は即座にエラーで返り、UI 側は再試行できるようになる。
/// 対応する待機が存在しない場合は何もしない（成功扱い）。
#[tauri::command]
pub fn cancel_oauth_flow(
    dispatcher: tauri::State<'_, OAuthDispatcher>,
    service: String,
) -> Result<(), String> {
    let tx = dispatcher
        .0
        .lock()
        .map_err(|_| "OAuth ディスパッチャのロック失敗".to_string())?
        .remove(&service);
    if let Some(tx) = tx {
        let _ = tx.send(Err("認証をキャンセルしました".to_string()));
    }
    Ok(())
}

/// `shirube-filer://oauth/gcs?code=xxx` から `"gcs"` を取り出す。
fn parse_service(url: &str) -> Option<String> {
    let without_scheme = url.splitn(2, "://").nth(1)?;
    let path = without_scheme.split('?').next()?;
    path.split('/').nth(1).filter(|s| !s.is_empty()).map(|s| s.to_string())
}

/// クエリ文字列からキーに対応する値を取り出す。
pub fn parse_qs(url: &str, key: &str) -> Option<String> {
    url.split('?').nth(1)?.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        (it.next()? == key).then(|| url_decode(it.next().unwrap_or("")))
    })
}

fn url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &value[i + 1..i + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    i += 3;
                    continue;
                }
                decoded.push(bytes[i]);
            }
            b'+' => decoded.push(b' '),
            byte => decoded.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

pub fn generate_code_verifier() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS 乱数の取得に失敗");
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn generate_code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

// ── URL percent-encoding ─────────────────────────────────────────────────────

pub fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ── Browser opener ───────────────────────────────────────────────────────────

pub fn open_browser(url: &str) {
    // `cmd /C start` は URL 中の `&` をコマンド区切りとして解釈し、
    // クエリパラメータが client_id 以降すべて欠落するため使用しない。
    // opener プラグイン（Windows: ShellExecuteW 相当）ならシェル解釈を経由しない。
    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
}

// ── Unified OAuth wait helper ─────────────────────────────────────────────────

/// ディスパッチャにセンダーを登録し、ブラウザを開いて認証コードを最大5分待機する。
pub async fn wait_for_oauth_code(
    dispatcher: &OAuthDispatcher,
    service: &str,
    auth_url: &str,
) -> Result<String, String> {
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    dispatcher
        .0
        .lock()
        .map_err(|_| "OAuth ディスパッチャのロック失敗".to_string())?
        .insert(service.to_string(), tx);

    open_browser(auth_url);

    tokio::time::timeout(std::time::Duration::from_secs(300), rx)
        .await
        .map_err(|_| "認証タイムアウト（5 分以内に認証してください）".to_string())?
        .map_err(|_| "OAuth チャネルが閉じられました".to_string())?
}

/// デスクトップ向け OAuth の認可応答を、一時的な loopback HTTP リスナーで受信する。
pub async fn wait_for_loopback_oauth_code<F>(
    dispatcher: &OAuthDispatcher,
    service: &str,
    expected_state: &str,
    build_auth_url: F,
) -> Result<(String, String), String>
where
    F: FnOnce(&str) -> String,
{
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("OAuth コールバック待受の開始に失敗: {}", e))?;
    let address = listener
        .local_addr()
        .map_err(|e| format!("OAuth コールバック待受アドレスの取得に失敗: {}", e))?;
    let redirect_uri = format!("http://127.0.0.1:{}", address.port());

    let (cancel_tx, cancel_rx) = oneshot::channel::<Result<String, String>>();
    dispatcher
        .0
        .lock()
        .map_err(|_| "OAuth ディスパッチャのロック失敗".to_string())?
        .insert(service.to_string(), cancel_tx);

    open_browser(&build_auth_url(&redirect_uri));

    let callback = async {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("OAuth コールバックの受信に失敗: {}", e))?;
        let mut request = vec![0u8; 8192];
        let read = stream
            .read(&mut request)
            .await
            .map_err(|e| format!("OAuth コールバックの読み取りに失敗: {}", e))?;
        let request = String::from_utf8_lossy(&request[..read]);
        let result = parse_loopback_callback(&request, expected_state);
        let (status, message) = if result.is_ok() {
            ("200 OK", "Google Drive への接続が完了しました。このタブを閉じて Shirube-Filer に戻ってください。")
        } else {
            ("400 Bad Request", "Google Drive への接続を完了できませんでした。Shirube-Filer に戻って再試行してください。")
        };
        let body = format!(
            "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>Shirube-Filer</title><body><p>{}</p></body></html>",
            message
        );
        let response = format!(
            "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            status,
            body.len(),
            body,
        );
        let _ = stream.write_all(response.as_bytes()).await;
        result
    };

    let result = match tokio::time::timeout(std::time::Duration::from_secs(300), async {
        tokio::select! {
            result = callback => result,
            cancelled = cancel_rx => cancelled
                .map_err(|_| "OAuth チャネルが閉じられました".to_string())?,
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("認証タイムアウト（5 分以内に認証してください）".to_string()),
    };

    if let Ok(mut map) = dispatcher.0.lock() {
        map.remove(service);
    }

    result.map(|code| (code, redirect_uri))
}

fn parse_loopback_callback(request: &str, expected_state: &str) -> Result<String, String> {
    let request_target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "OAuth コールバックの形式が不正です".to_string())?;

    let state = parse_qs(request_target, "state")
        .ok_or_else(|| "OAuth コールバックに state が含まれていません".to_string())?;
    if state != expected_state {
        return Err("OAuth コールバックの state が一致しません".to_string());
    }
    if let Some(error) = parse_qs(request_target, "error") {
        return Err(format!("OAuth 認証エラー: {}", error));
    }
    parse_qs(request_target, "code")
        .ok_or_else(|| "OAuth コールバックに認証コードが含まれていません".to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_loopback_callback;

    #[test]
    fn parses_valid_loopback_callback() {
        let request = "GET /?code=code%2Fvalue&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(
            parse_loopback_callback(request, "expected"),
            Ok("code/value".to_string()),
        );
    }

    #[test]
    fn rejects_loopback_callback_with_wrong_state() {
        let request = "GET /?code=code&state=unexpected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(
            parse_loopback_callback(request, "expected"),
            Err("OAuth コールバックの state が一致しません".to_string()),
        );
    }

    #[test]
    fn returns_oauth_error_from_loopback_callback() {
        let request =
            "GET /?error=access_denied&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(
            parse_loopback_callback(request, "expected"),
            Err("OAuth 認証エラー: access_denied".to_string()),
        );
    }
}
