//! 組み込みの静的ファイルサーバー。
//!
//! 選んだフォルダをルートに、指定ポートで HTTP 配信する。package.json のような
//! マニフェストが無いフォルダ（素の HTML/CSS/JS）でも、ブラウザで確認できるように
//! するためのもの。
//!
//! 待ち受けは **127.0.0.1 のみ**。同じ LAN の他の端末からは見えない。フォルダの
//! 中身をそのまま配るので、既定で外に出さないことは仕様の一部として守る。
//!
//! 実装は std のみ（GET / HEAD だけを見る小さな HTTP/1.1）。受け取ったパスは
//! `resolve_request_path` でルート配下に収まることを確かめてから開く。
//!
//! ホットリロード: ルート配下を notify で監視し、配信する HTML に小さな
//! クライアントスクリプトを挿し込む。ブラウザは `/__shirube_reload` へ
//! Server-Sent Events で繋ぎ、変更が落ち着いたら再読み込みする。

use crate::config::config_dir;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 同時に立てられるサーバーの数。
const MAX_SERVERS: usize = 8;
/// 登録しておける「ルート＋ポート」の組み合わせの数。
const MAX_PRESETS: usize = 32;
/// 特権ポートは使わせない（管理者権限を要求される・OS に予約されている）。
const MIN_PORT: u16 = 1024;
/// 同時に処理する接続数の上限（スレッドが無制限に増えないように）。
const MAX_INFLIGHT: usize = 64;
/// リクエスト行＋ヘッダーの読み取り上限。
const MAX_HEADER_BYTES: usize = 16 * 1024;
/// 1 接続あたりの読み書きのタイムアウト。
const IO_TIMEOUT: Duration = Duration::from_secs(15);
/// accept をポーリングする間隔（停止要求への反応の速さ）。
const ACCEPT_POLL: Duration = Duration::from_millis(50);
/// ホットリロードの通知を受け取るパス（この名前のファイルより優先する）。
pub const RELOAD_PATH: &str = "/__shirube_reload";
/// 変更が止まってから再読み込みを送るまでの待ち時間（保存の連打をまとめる）。
const RELOAD_DEBOUNCE: Duration = Duration::from_millis(150);
/// 変更を見に行く間隔。停止要求への反応もこの間隔で見る。
const RELOAD_POLL: Duration = Duration::from_millis(100);
/// 通知が無いときに繋ぎっぱなしの接続へ送る合図の間隔（切れた接続の掃除にも使う）。
const RELOAD_HEARTBEAT: Duration = Duration::from_secs(15);
/// スクリプトを挿し込む HTML の上限（これより大きいものはそのまま配る）。
const MAX_INJECT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticServerInfo {
    pub port: u16,
    /// 配信しているフォルダ（正規化後の絶対パス）
    pub root: String,
    /// ブラウザで開く URL
    pub url: String,
    /// ルート配下の変更でブラウザを再読み込みさせるか
    pub live_reload: bool,
}

/// ホットリロードの状態。監視スレッドが書き、SSE 接続が読む。
struct ReloadState {
    /// 変更のたびに増える世代番号
    generation: AtomicU64,
    /// 直近の変更からの経過を測るための基準時刻（プロセス開始からのミリ秒）
    changed_at_ms: AtomicU64,
    /// 起動からの経過時間の基準（Instant は atomic に置けないため差分で持つ）
    started: Instant,
}

impl ReloadState {
    fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            changed_at_ms: AtomicU64::new(0),
            started: Instant::now(),
        }
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// 変更を 1 件受け取った。
    fn touch(&self) {
        self.changed_at_ms.store(self.now_ms(), Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    /// 送るべき世代があり、かつ変更が落ち着いていれば その世代を返す。
    fn settled_generation(&self, sent: u64) -> Option<u64> {
        let current = self.generation.load(Ordering::Relaxed);
        if current == sent {
            return None;
        }
        let quiet_for = self
            .now_ms()
            .saturating_sub(self.changed_at_ms.load(Ordering::Relaxed));
        if quiet_for >= RELOAD_DEBOUNCE.as_millis() as u64 {
            Some(current)
        } else {
            None
        }
    }
}

struct RunningServer {
    info: StaticServerInfo,
    stop: Arc<AtomicBool>,
    /// 監視を続けるために持っておく（drop すると監視が止まる）
    #[allow(dead_code)]
    watcher: Option<RecommendedWatcher>,
}

static SERVERS: Lazy<Mutex<HashMap<u16, RunningServer>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// ── パス解決（ここが配信範囲を決める最後の砦） ──────────────────────────

/// URL の 1 区画を percent-decode する。`%XX` 以外はそのまま通す。
fn percent_decode_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            let byte = u8::from_str_radix(hex, 16).ok()?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// リクエストパスをルート配下の実パスへ解決する。範囲外・解決不能なら None。
///
/// `/` で区切ってから区画ごとに decode する（`%2F` を区切りとして扱わないため）。
/// `..` は decode 後に弾き、最後に canonicalize してルート配下かを確かめる
/// （シンボリックリンクで外へ出るのを防ぐ）。
pub fn resolve_request_path(root: &Path, url_path: &str) -> Option<PathBuf> {
    let Ok(root) = root.canonicalize() else {
        return None;
    };
    let mut path = root.clone();
    for raw in url_path.split('/') {
        if raw.is_empty() {
            continue;
        }
        let segment = percent_decode_segment(raw)?;
        if segment == "." {
            continue;
        }
        if segment == ".."
            || segment.contains('/')
            || segment.contains('\\')
            || segment.contains(':')
            || segment.contains('\0')
        {
            return None;
        }
        path.push(segment);
    }
    let resolved = path.canonicalize().ok()?;
    if resolved == root || resolved.starts_with(&root) {
        Some(resolved)
    } else {
        None
    }
}

// ── レスポンスの組み立て ────────────────────────────────────────────────

pub fn content_type_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml; charset=utf-8",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// HTML に埋める文字列を無害化する（フォルダ一覧のファイル名に使う）。
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// URL に埋めるファイル名を percent-encode する（英数と一部記号以外を退避）。
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

/// 配信する HTML に挿し込むホットリロードのクライアント。
///
/// `EventSource` で通知を待ち、届いたら再読み込みする。サーバーを止めると
/// 接続が切れるので、復帰したら自動で繋ぎ直せるよう再接続も入れる。
pub fn live_reload_script() -> String {
    format!(
        "<script data-shirube-live-reload>(function(){{\
var es;var open=function(){{\
es=new EventSource('{path}');\
es.onmessage=function(e){{if(e.data==='reload'){{location.reload();}}}};\
es.onerror=function(){{es.close();setTimeout(open,1000);}};\
}};open();}})();</script>",
        path = RELOAD_PATH
    )
}

/// HTML の `</body>` の直前にスクリプトを挿す。無ければ末尾に足す。
///
/// 大文字小文字の書き方は文書によって違う（`</BODY>` もある）ので、
/// 最後に現れる閉じタグを大小無視で探す。
pub fn inject_live_reload(html: &str) -> String {
    let script = live_reload_script();
    let lower = html.to_lowercase();
    match lower.rfind("</body>") {
        Some(idx) => format!("{}{}{}", &html[..idx], script, &html[idx..]),
        None => format!("{html}{script}"),
    }
}

fn is_html_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "html" | "htm"
    )
}

/// index.html が無いフォルダのための一覧ページ。
pub fn directory_listing(dir: &Path, url_path: &str, live_reload: bool) -> String {
    let mut entries: Vec<(String, bool)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| {
                    let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    (e.file_name().to_string_lossy().to_string(), is_dir)
                })
                .collect()
        })
        .unwrap_or_default();
    // フォルダを先に、あとは名前順（毎回同じ並びで出す）
    entries.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });

    let shown_path = escape_html(url_path);
    let mut body = String::new();
    body.push_str("<!doctype html><html><head><meta charset=\"utf-8\">");
    body.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
    body.push_str(&format!("<title>{shown_path}</title>"));
    body.push_str(
        "<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.7}\
         a{text-decoration:none;color:#2563eb}li{list-style:none}\
         ul{padding:0}code{color:#666}</style>",
    );
    body.push_str(&format!(
        "</head><body><h1><code>{shown_path}</code></h1><ul>"
    ));
    if url_path != "/" {
        body.push_str("<li><a href=\"../\">../</a></li>");
    }
    for (name, is_dir) in entries {
        let href = format!(
            "{}{}",
            encode_uri_component(&name),
            if is_dir { "/" } else { "" }
        );
        let label = format!("{}{}", escape_html(&name), if is_dir { "/" } else { "" });
        body.push_str(&format!("<li><a href=\"{href}\">{label}</a></li>"));
    }
    body.push_str("</ul>");
    if live_reload {
        body.push_str(&live_reload_script());
    }
    body.push_str("</body></html>");
    body
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    if !head_only {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn write_error(stream: &mut TcpStream, status: &str, head_only: bool) {
    let body = format!("<!doctype html><html><body><h1>{status}</h1></body></html>");
    let _ = write_response(
        stream,
        status,
        "text/html; charset=utf-8",
        body.as_bytes(),
        head_only,
    );
}

/// リクエスト行を `(メソッド, パス)` に分解する。読めなければ None。
pub fn parse_request_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.trim_end().split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?;
    // HTTP バージョンは見ない（1.0/1.1 のどちらでも Connection: close で返す）
    if method.is_empty() || !target.starts_with('/') {
        return None;
    }
    // クエリとフラグメントは静的配信では使わない
    let path = target
        .split('?')
        .next()
        .unwrap_or("/")
        .split('#')
        .next()
        .unwrap_or("/");
    Some((method, path.to_string()))
}

/// ホットリロードの通知を流し続ける（Server-Sent Events）。
///
/// 変更が落ち着いたら `data: reload` を送る。何も無いときは合図を送って、
/// 閉じられた接続（タブを閉じた・別ページへ移った）を書き込みの失敗で捨てる。
fn serve_reload_stream(stream: &mut TcpStream, reload: &ReloadState, stop: &AtomicBool) {
    let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n";
    if stream.write_all(header.as_bytes()).is_err() || stream.flush().is_err() {
        return;
    }
    let mut sent = reload.generation.load(Ordering::Relaxed);
    let mut last_beat = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        if let Some(generation) = reload.settled_generation(sent) {
            if stream.write_all(b"data: reload\n\n").is_err() || stream.flush().is_err() {
                return;
            }
            sent = generation;
            last_beat = Instant::now();
        } else if last_beat.elapsed() >= RELOAD_HEARTBEAT {
            // コメント行。ブラウザ側は無視するが、切れた接続はここで分かる
            if stream.write_all(b": ping\n\n").is_err() || stream.flush().is_err() {
                return;
            }
            last_beat = Instant::now();
        }
        std::thread::sleep(RELOAD_POLL);
    }
}

fn handle_connection(
    root: &Path,
    mut stream: TcpStream,
    reload: Option<&ReloadState>,
    stop: &AtomicBool,
) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader
        .by_ref()
        .take(MAX_HEADER_BYTES as u64)
        .read_line(&mut request_line)
        .is_err()
        || request_line.is_empty()
    {
        return;
    }

    let Some((method, url_path)) = parse_request_line(&request_line) else {
        write_error(&mut stream, "400 Bad Request", false);
        return;
    };
    let head_only = method == "HEAD";
    if method != "GET" && !head_only {
        write_error(&mut stream, "405 Method Not Allowed", head_only);
        return;
    }

    // ホットリロードの通知口。実ファイルより先に見る
    if url_path == RELOAD_PATH {
        match reload {
            Some(state) if !head_only => serve_reload_stream(&mut stream, state, stop),
            Some(_) => {
                let _ = write_response(&mut stream, "200 OK", "text/event-stream", b"", true);
            }
            None => write_error(&mut stream, "404 Not Found", head_only),
        }
        return;
    }

    let Some(target) = resolve_request_path(root, &url_path) else {
        write_error(&mut stream, "404 Not Found", head_only);
        return;
    };

    let live_reload = reload.is_some();

    if target.is_dir() {
        let index = target.join("index.html");
        if index.is_file() {
            serve_file(&mut stream, &index, head_only, live_reload);
            return;
        }
        // 末尾に / が無いと相対リンクが 1 階層ずれるので、付けてから一覧を出す
        if !url_path.ends_with('/') {
            let location = format!("{url_path}/");
            let header = format!(
                "HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\n\
                 Content-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.flush();
            return;
        }
        let body = directory_listing(&target, &url_path, live_reload);
        let _ = write_response(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            body.as_bytes(),
            head_only,
        );
        return;
    }

    if target.is_file() {
        serve_file(&mut stream, &target, head_only, live_reload);
        return;
    }

    write_error(&mut stream, "404 Not Found", head_only);
}

fn serve_file(stream: &mut TcpStream, path: &Path, head_only: bool, live_reload: bool) {
    let Ok(meta) = std::fs::metadata(path) else {
        write_error(stream, "404 Not Found", head_only);
        return;
    };

    // HTML にはホットリロードのクライアントを挿し込む。挿し込むと長さが変わるので
    // ここで本文を作ってから Content-Length を決める（巨大な HTML はそのまま配る）。
    if live_reload && is_html_path(path) && meta.len() <= MAX_INJECT_BYTES {
        if let Ok(html) = std::fs::read_to_string(path) {
            let body = inject_live_reload(&html);
            let _ = write_response(
                stream,
                "200 OK",
                content_type_for(path),
                body.as_bytes(),
                head_only,
            );
            return;
        }
    }
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\n\
         Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
        content_type_for(path),
        meta.len()
    );
    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }
    if head_only {
        let _ = stream.flush();
        return;
    }
    // 大きなファイルを丸ごとメモリに載せないよう、そのまま流す
    if let Ok(mut file) = std::fs::File::open(path) {
        let _ = std::io::copy(&mut file, stream);
    }
    let _ = stream.flush();
}

// ── 登録プリセット（ルート＋ポートの組み合わせを使い回す） ──────────────

/// よく配信するフォルダとポートの組み合わせ。設定フォルダに YAML で残す。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPreset {
    pub id: String,
    /// 表示名。空ならフォルダ名を出す。
    #[serde(default)]
    pub label: String,
    pub root: String,
    pub port: u16,
    /// ルート配下の変更でブラウザを再読み込みさせるか。
    /// この欄が無い頃に保存された登録は有効として扱う（この機能の既定）。
    #[serde(default = "default_live_reload")]
    pub live_reload: bool,
}

fn default_live_reload() -> bool {
    true
}

fn presets_path() -> PathBuf {
    config_dir().join("server-presets.yaml")
}

pub fn parse_presets(raw: &str) -> Result<Vec<ServerPreset>, String> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_yaml::from_str::<Vec<ServerPreset>>(raw).map_err(|e| e.to_string())
}

pub fn serialize_presets(presets: &[ServerPreset]) -> Result<String, String> {
    serde_yaml::to_string(presets).map_err(|e| e.to_string())
}

/// 保存前の検査。壊れた登録を書き込んで、次の起動時に一覧ごと読めなくなるのを防ぐ。
pub fn validate_presets(presets: &[ServerPreset]) -> Result<(), String> {
    if presets.len() > MAX_PRESETS {
        return Err(format!("登録できるのは {MAX_PRESETS} 件までです"));
    }
    let mut seen_ids: Vec<&str> = Vec::with_capacity(presets.len());
    for preset in presets {
        if preset.id.trim().is_empty() {
            return Err("id が空の登録があります".to_string());
        }
        if seen_ids.contains(&preset.id.as_str()) {
            return Err(format!("id が重複しています: {}", preset.id));
        }
        seen_ids.push(&preset.id);
        if preset.root.trim().is_empty() {
            return Err("フォルダが空の登録があります".to_string());
        }
        if preset.port < MIN_PORT {
            return Err(format!(
                "ポートは {MIN_PORT} 以上を指定してください（{} は使えません）",
                preset.port
            ));
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn load_server_presets() -> Result<Vec<ServerPreset>, String> {
    let path = presets_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    parse_presets(&raw)
}

#[tauri::command(async)]
pub fn save_server_presets(presets: Vec<ServerPreset>) -> Result<(), String> {
    validate_presets(&presets)?;
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let yaml = serialize_presets(&presets)?;
    std::fs::write(presets_path(), yaml).map_err(|e| e.to_string())
}

// ── コマンド ────────────────────────────────────────────────────────────

fn info_for(port: u16, root: &Path, live_reload: bool) -> StaticServerInfo {
    StaticServerInfo {
        port,
        root: root.to_string_lossy().to_string(),
        url: format!("http://127.0.0.1:{port}/"),
        live_reload,
    }
}

/// ルート配下を監視して、変更を `ReloadState` に記録する監視を始める。
fn start_watcher(root: &Path, reload: Arc<ReloadState>) -> Result<RecommendedWatcher, String> {
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                // アクセス（読み取り）だけの通知で再読み込みはしない
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                reload.touch();
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("変更の監視を開始できません: {e}"))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("変更の監視を開始できません: {e}"))?;
    Ok(watcher)
}

/// 指定フォルダをルートに、127.0.0.1 の指定ポートで配信を始める。
///
/// `live_reload` を有効にすると、ルート配下の変更でブラウザが再読み込みする
/// （配信する HTML にクライアントスクリプトを挿し込む）。省略時は有効。
#[tauri::command(async)]
pub fn start_static_server(
    root: String,
    port: u16,
    live_reload: Option<bool>,
) -> Result<StaticServerInfo, String> {
    if port < MIN_PORT {
        return Err(format!(
            "ポートは {MIN_PORT} 以上を指定してください（{port} は使えません）"
        ));
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("フォルダが見つかりません: {root}"));
    }
    let root_canonical = root_path
        .canonicalize()
        .map_err(|e| format!("フォルダを解決できません: {e}"))?;

    {
        let servers = SERVERS.lock().map_err(|e| e.to_string())?;
        if servers.contains_key(&port) {
            return Err(format!("ポート {port} は既にこのアプリが使っています"));
        }
        if servers.len() >= MAX_SERVERS {
            return Err(format!(
                "同時に立てられるサーバーは {MAX_SERVERS} 個までです"
            ));
        }
    }

    // 外に出さない: ループバックだけで待ち受ける
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let listener = TcpListener::bind(addr).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("ポート {port} は他のプロセスが使用中です")
        } else {
            format!("ポート {port} を開けません: {e}")
        }
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("ソケットを設定できません: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    // 監視を始められない環境（inotify の上限など）でも配信そのものは続ける
    let live_reload = live_reload.unwrap_or(true);
    let reload_state = if live_reload {
        Some(Arc::new(ReloadState::new()))
    } else {
        None
    };
    let watcher = match reload_state.as_ref() {
        Some(state) => match start_watcher(&root_canonical, state.clone()) {
            Ok(w) => Some(w),
            Err(e) => {
                eprintln!("[static_server] {e}");
                None
            }
        },
        None => None,
    };
    let info = info_for(port, &root_canonical, reload_state.is_some());

    {
        let mut servers = SERVERS.lock().map_err(|e| e.to_string())?;
        servers.insert(
            port,
            RunningServer {
                info: info.clone(),
                stop: stop.clone(),
                watcher,
            },
        );
    }

    let thread_root = root_canonical.clone();
    std::thread::spawn(move || {
        let inflight = Arc::new(AtomicUsize::new(0));
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    if inflight.load(Ordering::Relaxed) >= MAX_INFLIGHT {
                        // 捌けない接続は握り続けずに切る
                        drop(stream);
                        continue;
                    }
                    inflight.fetch_add(1, Ordering::Relaxed);
                    let conn_root = thread_root.clone();
                    let conn_inflight = inflight.clone();
                    let conn_reload = reload_state.clone();
                    let conn_stop = stop.clone();
                    std::thread::spawn(move || {
                        handle_connection(&conn_root, stream, conn_reload.as_deref(), &conn_stop);
                        conn_inflight.fetch_sub(1, Ordering::Relaxed);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(ACCEPT_POLL);
                }
                Err(_) => break,
            }
        }
        // 停止時・異常終了時ともに一覧から消す（ポートを再利用できるように）
        if let Ok(mut servers) = SERVERS.lock() {
            if let Some(entry) = servers.get(&port) {
                // 自分より後に同じポートで立ち上がったサーバーを消さない
                if Arc::ptr_eq(&entry.stop, &stop) {
                    servers.remove(&port);
                }
            }
        }
    });

    Ok(info)
}

/// 配信を止める。
#[tauri::command(async)]
pub fn stop_static_server(port: u16) -> Result<(), String> {
    let mut servers = SERVERS.lock().map_err(|e| e.to_string())?;
    let Some(server) = servers.remove(&port) else {
        return Err(format!("ポート {port} のサーバーは動いていません"));
    };
    server.stop.store(true, Ordering::Relaxed);
    Ok(())
}

/// いま動いている配信の一覧（パネルを開き直したときの復元に使う）。
#[tauri::command(async)]
pub fn list_static_servers() -> Result<Vec<StaticServerInfo>, String> {
    let servers = SERVERS.lock().map_err(|e| e.to_string())?;
    let mut list: Vec<StaticServerInfo> = servers.values().map(|s| s.info.clone()).collect();
    list.sort_by_key(|s| s.port);
    Ok(list)
}

// ── テスト ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("shirube-server-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    // ── パス解決 ────────────────────────────────────────────────────
    // 配信するフォルダはユーザーが選ぶが、リクエストは外から来る。ここが
    // ルート外のファイルを出さないための最後の砦になる。

    #[test]
    fn serves_files_inside_the_root() {
        let root = tmpdir("inside");
        write_file(&root.join("index.html"), "hi");
        write_file(&root.join("assets/app.css"), "body{}");

        assert_eq!(
            resolve_request_path(&root, "/index.html"),
            Some(root.canonicalize().unwrap().join("index.html"))
        );
        assert_eq!(
            resolve_request_path(&root, "/assets/app.css"),
            Some(root.canonicalize().unwrap().join("assets").join("app.css"))
        );
        // ルート自身
        assert_eq!(
            resolve_request_path(&root, "/"),
            Some(root.canonicalize().unwrap())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_climb_out_of_the_root() {
        let base = tmpdir("climb");
        let root = base.join("public");
        write_file(&root.join("index.html"), "hi");
        write_file(&base.join("secret.txt"), "秘密");

        for path in [
            "/../secret.txt",
            "/assets/../../secret.txt",
            "/..%2Fsecret.txt",
            "/%2e%2e/secret.txt",
            "/....//secret.txt",
        ] {
            assert_eq!(resolve_request_path(&root, path), None, "通した: {path}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn treats_encoded_slashes_as_part_of_the_name_not_a_separator() {
        let root = tmpdir("encoded-slash");
        write_file(&root.join("index.html"), "hi");
        // "%2F" を区切りとして扱うと ".." と組み合わせて外へ出られてしまう
        assert_eq!(resolve_request_path(&root, "/a%2F..%2F..%2Fetc"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn decodes_percent_escaped_names() {
        let root = tmpdir("decode");
        write_file(&root.join("日本語 ファイル.txt"), "x");
        let resolved = resolve_request_path(
            &root,
            "/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.txt",
        );
        assert_eq!(
            resolved,
            Some(root.canonicalize().unwrap().join("日本語 ファイル.txt"))
        );
        // 壊れた escape は弾く
        assert_eq!(resolve_request_path(&root, "/%zz"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_symlink_that_points_outside_the_root() {
        let base = tmpdir("symlink");
        let root = base.join("public");
        write_file(&root.join("index.html"), "hi");
        write_file(&base.join("secret.txt"), "秘密");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret.txt"), root.join("leak.txt")).unwrap();
            assert_eq!(
                resolve_request_path(&root, "/leak.txt"),
                None,
                "シンボリックリンク越しにルート外を配信している"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn refuses_paths_for_files_that_do_not_exist() {
        let root = tmpdir("missing");
        write_file(&root.join("index.html"), "hi");
        assert_eq!(resolve_request_path(&root, "/nope.html"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── リクエスト行 ────────────────────────────────────────────────

    #[test]
    fn reads_the_request_line() {
        assert_eq!(
            parse_request_line("GET /index.html HTTP/1.1\r\n"),
            Some(("GET".into(), "/index.html".into()))
        );
        // クエリとフラグメントは落とす
        assert_eq!(
            parse_request_line("GET /a.js?v=3#top HTTP/1.1\r\n"),
            Some(("GET".into(), "/a.js".into()))
        );
        assert_eq!(
            parse_request_line("HEAD / HTTP/1.0\r\n"),
            Some(("HEAD".into(), "/".into()))
        );
    }

    #[test]
    fn rejects_request_lines_that_are_not_origin_form() {
        for line in [
            "",
            "GET\r\n",
            "GET index.html HTTP/1.1\r\n",
            // 絶対 URI 形式は受けない（他サイトのプロキシとして振る舞わない）
            "GET http://example.com/ HTTP/1.1\r\n",
        ] {
            assert_eq!(parse_request_line(line), None, "通した: {line:?}");
        }
    }

    // ── 表示 ────────────────────────────────────────────────────────

    #[test]
    fn lists_folders_before_files() {
        let root = tmpdir("listing-order");
        write_file(&root.join("b.txt"), "x");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let html = directory_listing(&root, "/", false);

        let sub = html.find("sub/").expect("フォルダが出ていない");
        let file = html.find("b.txt").expect("ファイルが出ていない");
        assert!(sub < file, "フォルダが先に並んでいない");
        // 親への戻りはルートでは出さない
        assert!(!html.contains("../"));
        assert!(directory_listing(&root, "/sub/", false).contains("../"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 一覧に出るのはユーザーのファイル名。そのまま埋めると、名前だけで
    /// ブラウザ上のスクリプトを仕込めてしまう。
    #[test]
    fn escapes_html_in_names() {
        assert_eq!(
            escape_html("<img src=x onerror=alert(1)>"),
            "&lt;img src=x onerror=alert(1)&gt;"
        );
        assert_eq!(escape_html("a&b\"c\'d"), "a&amp;b&quot;c&#39;d");
    }

    // Windows では `<` `>` をファイル名に使えないため、実ファイルを作る確認は unix だけ。
    #[cfg(unix)]
    #[test]
    fn a_file_name_cannot_inject_markup_into_the_listing() {
        let root = tmpdir("listing-escape");
        write_file(&root.join("<img src=x onerror=alert(1)>.txt"), "x");
        let html = directory_listing(&root, "/", false);

        assert!(!html.contains("<img src=x"), "生の HTML を埋めている");
        assert!(html.contains("&lt;img src=x"));
        // href 側も生では入れない
        assert!(html.contains("%3Cimg"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn picks_a_content_type_browsers_understand() {
        assert_eq!(
            content_type_for(Path::new("a/index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type_for(Path::new("a/app.JS")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type_for(Path::new("a/logo.png")), "image/png");
        assert_eq!(
            content_type_for(Path::new("a/mod.wasm")),
            "application/wasm"
        );
        assert_eq!(
            content_type_for(Path::new("a/unknown.bin")),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_for(Path::new("a/noext")),
            "application/octet-stream"
        );
    }

    #[test]
    fn percent_encodes_links_so_odd_names_stay_clickable() {
        assert_eq!(encode_uri_component("a b.txt"), "a%20b.txt");
        assert_eq!(encode_uri_component("a#b?c.txt"), "a%23b%3Fc.txt");
        assert_eq!(
            encode_uri_component("plain-name_1.0.txt"),
            "plain-name_1.0.txt"
        );
    }

    // ── 起動・停止 ──────────────────────────────────────────────────

    #[test]
    fn refuses_privileged_ports_and_missing_folders() {
        let root = tmpdir("validate");
        assert!(start_static_server(root.to_string_lossy().to_string(), 80, None).is_err());
        assert!(start_static_server("/does/not/exist".to_string(), 8099, None).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn serves_a_file_over_http_then_stops() {
        let root = tmpdir("roundtrip");
        write_file(&root.join("index.html"), "<h1>hello</h1>");

        // 空きポートを OS に選ばせて、その番号で立て直す
        let probe = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let info =
            start_static_server(root.to_string_lossy().to_string(), port, Some(false)).unwrap();
        assert_eq!(info.url, format!("http://127.0.0.1:{port}/"));
        assert!(list_static_servers()
            .unwrap()
            .iter()
            .any(|s| s.port == port));

        let body = http_get(port, "/");
        assert!(body.starts_with("HTTP/1.1 200 OK"), "{body}");
        assert!(body.contains("<h1>hello</h1>"));
        assert!(body.contains("text/html; charset=utf-8"));

        // ルート外は 404（実ファイルは存在していても出さない）
        let outside = http_get(port, "/../index.html");
        assert!(outside.starts_with("HTTP/1.1 404"), "{outside}");

        // GET / HEAD 以外は 405
        let posted = http_request(port, "POST / HTTP/1.1\r\nHost: localhost\r\n\r\n");
        assert!(posted.starts_with("HTTP/1.1 405"), "{posted}");

        stop_static_server(port).unwrap();
        // 停止後は一覧から消え、二重停止はエラーになる
        let mut gone = false;
        for _ in 0..40 {
            if !list_static_servers()
                .unwrap()
                .iter()
                .any(|s| s.port == port)
            {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(gone, "停止後も一覧に残っている");
        assert!(stop_static_server(port).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── ホットリロード ──────────────────────────────────────────────

    #[test]
    fn injects_the_client_just_before_the_closing_body_tag() {
        let html = "<html><body><h1>hi</h1></body></html>";
        let out = inject_live_reload(html);
        assert!(out.starts_with("<html><body><h1>hi</h1>"));
        assert!(out.ends_with("</body></html>"));
        assert!(out.contains(RELOAD_PATH));
        // 本文より後ろに置く（読み込みを妨げないため）
        assert!(out.find("<h1>hi</h1>").unwrap() < out.find("EventSource").unwrap());
    }

    #[test]
    fn injects_into_html_that_has_no_body_tag() {
        // 閉じタグの書き方は文書によって違う。断片だけの HTML でも落とさない
        let out = inject_live_reload("<h1>hi</h1>");
        assert!(out.starts_with("<h1>hi</h1>"));
        assert!(out.contains(RELOAD_PATH));

        let upper = inject_live_reload("<HTML><BODY>hi</BODY></HTML>");
        assert!(upper.contains(RELOAD_PATH));
        assert!(upper.ends_with("</BODY></HTML>"));
    }

    #[test]
    fn adds_the_client_to_the_generated_listing_only_when_enabled() {
        let root = tmpdir("listing-reload");
        write_file(&root.join("a.txt"), "x");
        assert!(directory_listing(&root, "/", true).contains(RELOAD_PATH));
        assert!(!directory_listing(&root, "/", false).contains(RELOAD_PATH));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn waits_for_changes_to_settle_before_asking_for_a_reload() {
        let state = ReloadState::new();
        // 変更が無ければ送るものは無い
        assert_eq!(state.settled_generation(0), None);

        state.touch();
        // 直後は「まだ書き込み中かもしれない」ので送らない
        assert_eq!(state.settled_generation(0), None);
        std::thread::sleep(RELOAD_DEBOUNCE + Duration::from_millis(80));
        let generation = state
            .settled_generation(0)
            .expect("落ち着いた変更が出てこない");
        assert_eq!(generation, 1);
        // 送った世代のあとは、次の変更まで静かになる
        assert_eq!(state.settled_generation(generation), None);
    }

    #[test]
    fn hands_the_browser_a_reload_when_a_file_under_the_root_changes() {
        let root = tmpdir("reload-e2e");
        write_file(&root.join("index.html"), "<html><body>v1</body></html>");

        let probe = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        start_static_server(root.to_string_lossy().to_string(), port, Some(true)).unwrap();

        // 配信された HTML にクライアントが入っていること
        let page = http_get(port, "/");
        assert!(
            page.contains(RELOAD_PATH),
            "クライアントが挿し込まれていない: {page}"
        );

        // 通知口へ繋いでから、ファイルを書き換えて合図を待つ
        let mut stream = connect(port);
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
            .write_all(format!("GET {RELOAD_PATH} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
            .unwrap();

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("HTTP/1.1 200"), "{line}");
        let mut saw_event_stream = false;
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line.to_lowercase().contains("text/event-stream") {
                saw_event_stream = true;
            }
            if line.trim().is_empty() {
                break;
            }
        }
        assert!(saw_event_stream, "SSE として返っていない");

        // 監視が始まるまでの取りこぼしを避けて、少し置いてから書き換える
        std::thread::sleep(Duration::from_millis(300));
        write_file(&root.join("index.html"), "<html><body>v2</body></html>");

        let mut reloaded = false;
        for _ in 0..40 {
            line.clear();
            if reader.read_line(&mut line).is_err() || line.is_empty() {
                break;
            }
            if line.trim() == "data: reload" {
                reloaded = true;
                break;
            }
        }
        assert!(reloaded, "ファイルを変えても再読み込みの合図が来ない");

        stop_static_server(port).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn leaves_the_page_untouched_when_hot_reload_is_off() {
        let root = tmpdir("reload-off");
        write_file(&root.join("index.html"), "<html><body>v1</body></html>");

        let probe = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let info =
            start_static_server(root.to_string_lossy().to_string(), port, Some(false)).unwrap();
        assert!(!info.live_reload);

        let page = http_get(port, "/");
        assert!(!page.contains(RELOAD_PATH), "無効なのに挿し込んでいる");
        // 通知口も開けない
        let denied = http_get(port, RELOAD_PATH);
        assert!(denied.starts_with("HTTP/1.1 404"), "{denied}");

        stop_static_server(port).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 登録プリセット ──────────────────────────────────────────────

    fn preset(id: &str, root: &str, port: u16) -> ServerPreset {
        ServerPreset {
            id: id.to_string(),
            label: String::new(),
            root: root.to_string(),
            port,
            live_reload: true,
        }
    }

    #[test]
    fn keeps_presets_through_a_save_load_round_trip() {
        let presets = vec![
            ServerPreset {
                id: "a".into(),
                label: "サイト".into(),
                root: "/home/u/site".into(),
                port: 8080,
                live_reload: false,
            },
            preset("b", "C:\\dev\\docs", 8081),
        ];
        let yaml = serialize_presets(&presets).unwrap();
        assert_eq!(parse_presets(&yaml).unwrap(), presets);
    }

    #[test]
    fn reads_a_preset_that_predates_the_label_field() {
        let yaml = "- id: a\n  root: /home/u/site\n  port: 8080\n";
        let parsed = parse_presets(yaml).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].label, "");
        // ホットリロードを知らない頃の登録は、有効として読む
        assert!(parsed[0].live_reload);
        // 空ファイルは「登録なし」であって読み取り失敗ではない
        assert_eq!(parse_presets("").unwrap(), Vec::new());
        assert_eq!(parse_presets("   \n").unwrap(), Vec::new());
    }

    #[test]
    fn refuses_to_save_broken_presets() {
        // 壊れた登録を書き込むと、次に開いたとき一覧ごと読めなくなる
        assert!(validate_presets(&[preset("a", "/x", 8080)]).is_ok());
        assert!(validate_presets(&[preset("", "/x", 8080)]).is_err());
        assert!(validate_presets(&[preset("a", "  ", 8080)]).is_err());
        assert!(validate_presets(&[preset("a", "/x", 80)]).is_err());
        // 同じ id が 2 つあると、削除・起動が別の行に当たる
        assert!(validate_presets(&[preset("a", "/x", 8080), preset("a", "/y", 8081)]).is_err());
        // 同じフォルダを別ポートで持つのは許す
        assert!(validate_presets(&[preset("a", "/x", 8080), preset("b", "/x", 8081)]).is_ok());

        let too_many: Vec<ServerPreset> = (0..=MAX_PRESETS)
            .map(|i| preset(&format!("id{i}"), "/x", 8080 + i as u16))
            .collect();
        assert!(validate_presets(&too_many).is_err());
    }

    /// サーバーが立ち上がるまで少し待って接続する。
    fn connect(port: u16) -> TcpStream {
        for _ in 0..40 {
            if let Ok(s) = TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)) {
                return s;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("サーバーに接続できない");
    }

    fn http_request(port: u16, request: &str) -> String {
        let mut stream = connect(port);
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out);
        String::from_utf8_lossy(&out).to_string()
    }

    fn http_get(port: u16, path: &str) -> String {
        http_request(
            port,
            &format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n"),
        )
    }
}
