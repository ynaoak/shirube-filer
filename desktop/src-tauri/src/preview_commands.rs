use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MAX_PREVIEW_BYTES: usize = 10 * 1024 * 1024; // 10 MB

/// バイト列の先頭サンプルからテキストファイルらしいかを推定する。
/// git 同様に NUL バイトを含めばバイナリ、加えて制御文字の比率が高ければ
/// バイナリとみなす。UTF-8 か否かは問わない（Shift_JIS 等も表示可能とする）。
fn looks_like_text(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return true;
    }
    if sample.contains(&0) {
        return false;
    }
    // タブ/改行/復帰/フォームフィード以外の制御文字を「怪しい」とカウント。
    let suspicious = sample
        .iter()
        .filter(|&&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0c))
        .count();
    // 怪しいバイトが 10% 未満ならテキストとみなす。
    suspicious.saturating_mul(100) / sample.len() < 10
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSniff {
    /// テキストとして表示可能と判定されたか。
    pub is_text: bool,
    /// テキストと判定された場合の内容（バイナリなら空文字）。
    pub content: String,
}

/// ファイルの内容を読み、テキストとして表示可能かを判定して返す。
/// 拡張子に依らず「表示できると判定できたもの」はテキストとして扱えるようにする。
#[tauri::command(async)]
pub fn read_text_file_sniffed(path: String, max_bytes: usize) -> Result<TextSniff, String> {
    validate_path(&path)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("通常ファイルのみプレビュー可能です".to_string());
    }
    let capped = max_bytes.min(MAX_PREVIEW_BYTES);
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; capped];
    let n = file.read(&mut buf[..capped]).map_err(|e| e.to_string())?;
    buf.truncate(n);

    // 判定は先頭 8KB のサンプルで行う。
    let sample_len = n.min(8192);
    if !looks_like_text(&buf[..sample_len]) {
        return Ok(TextSniff { is_text: false, content: String::new() });
    }
    let content = String::from_utf8(buf)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok(TextSniff { is_text: true, content })
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("パスにNULLバイトは使用できません".to_string());
    }
    if !Path::new(path).is_absolute() {
        return Err(format!("絶対パスを指定してください: {}", path));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn read_text_file(path: String, max_bytes: usize) -> Result<String, String> {
    validate_path(&path)?;
    // Reject device files, named pipes, sockets, etc. — only regular files.
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("通常ファイルのみプレビュー可能です".to_string());
    }
    let capped = max_bytes.min(MAX_PREVIEW_BYTES);
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; capped];
    let n = file.read(&mut buf[..capped]).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(String::from_utf8(buf)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

/// Write text content to a file (used by the built-in editor).
#[tauri::command(async)]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    validate_path(&path)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("通常ファイルのみ書き込み可能です".to_string());
    }
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

/// Read a file and return it as a base64 data URL (for image preview).
#[tauri::command(async)]
pub fn read_file_as_data_url(path: String, mime_type: String) -> Result<String, String> {
    validate_path(&path)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("通常ファイルのみ読み取り可能です".to_string());
    }
    if meta.len() > 20 * 1024 * 1024 {
        return Err("ファイルが大きすぎます（20MB 超）".to_string());
    }
    use base64::engine::Engine as _;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime_type, b64))
}

/// Read raw bytes from a file for hex viewing. Returns base64-encoded bytes.
#[tauri::command(async)]
pub fn read_file_bytes(path: String, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    validate_path(&path)?;
    let capped = length.min(65536); // max 64 KB per call
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("通常ファイルのみ読み取り可能です".to_string());
    }
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; capped];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(buf)
}
