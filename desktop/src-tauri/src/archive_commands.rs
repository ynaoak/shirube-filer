use crate::config::safe_join;
use crate::progress::{CancelState, ProgressPayload};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::Emitter;
use jwalk::WalkDir as JWalkDir;

/// Maximum decompressed size to prevent decompression bombs (4 GB).
const MAX_DECOMPRESS_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveFormat {
    Zip,
    TarGz,
    Zstd,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveResult {
    pub path: String,
    pub file_count: usize,
    pub size: u64,
}

// ── ZIP ──────────────────────────────────────────────────────────────────────

fn extract_zip(src: &Path, dest_dir: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let file = File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
    let count = archive.len();
    for i in 0..count {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // Zip Slip prevention: use safe_join to reject any `..` or absolute components.
        let entry_name = entry.mangled_name();
        let out_path = safe_join(dest_dir, &entry_name).ok_or_else(|| {
            format!(
                "不正なZIPエントリ（パストラバーサル検出）: {}",
                entry.name()
            )
        })?;
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut out = File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(count)
}

// ── TAR.GZ ───────────────────────────────────────────────────────────────────

fn create_tar_gz(sources: &[PathBuf], dest: &Path) -> Result<(usize, u64), String> {
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let enc = GzEncoder::new(BufWriter::new(file), Compression::default());
    let mut tar = tar::Builder::new(enc);
    let mut count = 0usize;

    for source in sources {
        if source.is_dir() {
            let base = source.parent().unwrap_or(Path::new(""));
            let rel = source.strip_prefix(base).map_err(|e| e.to_string())?;
            tar.append_dir_all(rel, source)
                .map_err(|e| e.to_string())?;
            count += JWalkDir::new(source)
                .skip_hidden(false)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .count();
        } else {
            let name = source.file_name().ok_or("ファイル名が取得できません")?;
            let mut f = File::open(source).map_err(|e| e.to_string())?;
            tar.append_file(name, &mut f).map_err(|e| e.to_string())?;
            count += 1;
        }
    }

    tar.finish().map_err(|e| e.to_string())?;
    let size = dest.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((count, size))
}

fn extract_tar_gz(src: &Path, dest_dir: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let file = File::open(src).map_err(|e| e.to_string())?;
    let dec = GzDecoder::new(BufReader::new(file));
    let mut archive = tar::Archive::new(dec);
    let mut count = 0usize;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let out_path = safe_join(dest_dir, &entry_path).ok_or_else(|| {
            format!("不正なTARエントリ（パストラバーサル検出）: {}", entry_path.display())
        })?;
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut out_file = File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(count)
}

// ── ZSTD ─────────────────────────────────────────────────────────────────────

/// 非圧縮 tar アーカイブを作成する（zstd 圧縮の前段として使用）
fn create_tar_plain(sources: &[PathBuf], dest: &Path) -> Result<(usize, u64), String> {
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let mut tar = tar::Builder::new(BufWriter::new(file));
    let mut count = 0usize;

    for source in sources {
        if source.is_dir() {
            let base = source.parent().unwrap_or(Path::new(""));
            let rel = source.strip_prefix(base).map_err(|e| e.to_string())?;
            tar.append_dir_all(rel, source).map_err(|e| e.to_string())?;
            count += JWalkDir::new(source)
                .skip_hidden(false)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .count();
        } else {
            let name = source.file_name().ok_or("ファイル名が取得できません")?;
            let mut f = File::open(source).map_err(|e| e.to_string())?;
            tar.append_file(name, &mut f).map_err(|e| e.to_string())?;
            count += 1;
        }
    }

    tar.finish().map_err(|e| e.to_string())?;
    let size = dest.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((count, size))
}

fn create_zstd(sources: &[PathBuf], dest: &Path) -> Result<(usize, u64), String> {
    // zstd は単一ファイルフォーマットのため、複数ファイルはまず非圧縮 tar にまとめる
    let tmp = dest.with_extension("tmp.tar");
    let (count, _) = create_tar_plain(sources, &tmp)?;

    // ストリーミングで単一 zstd フレームに圧縮（並列チャンク分割は不正な出力を生成するため使用しない）
    {
        let in_file = File::open(&tmp).map_err(|e| e.to_string())?;
        let out_file = File::create(dest).map_err(|e| e.to_string())?;
        zstd::stream::copy_encode(BufReader::new(in_file), BufWriter::new(out_file), 3)
            .map_err(|e| e.to_string())?;
    }
    std::fs::remove_file(&tmp).ok();

    let size = dest.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((count, size))
}

fn extract_zstd(src: &Path, dest_dir: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;

    // Stream-decompress with a hard size cap to prevent decompression bombs.
    let in_file = File::open(src).map_err(|e| e.to_string())?;
    let decoder = zstd::Decoder::new(BufReader::new(in_file)).map_err(|e| e.to_string())?;
    let mut limited = std::io::Read::take(decoder, MAX_DECOMPRESS_BYTES);

    let tmp = dest_dir.join("_tmp_zstd.tar");
    {
        let mut tmp_file = File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut limited, &mut tmp_file).map_err(|e| e.to_string())?;
    }

    let mut archive = tar::Archive::new(BufReader::new(
        File::open(&tmp).map_err(|e| e.to_string())?,
    ));
    let mut count = 0usize;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let out_path = safe_join(dest_dir, &entry_path).ok_or_else(|| {
            format!("不正なTARエントリ（パストラバーサル検出）: {}", entry_path.display())
        })?;
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut out_file = File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    std::fs::remove_file(&tmp).ok();
    Ok(count)
}

// ── Tauri コマンド ────────────────────────────────────────────────────────────

/// Collect file paths from sources (recursively expands directories).
fn collect_sources(sources: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for src in sources {
        if src.is_file() {
            files.push(src.clone());
        } else if src.is_dir() {
            for entry in JWalkDir::new(src)
                .skip_hidden(false)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if entry.file_type().is_file() {
                    files.push(entry.path().to_path_buf());
                }
            }
        }
    }
    files
}

// 圧縮・展開はファイル数とサイズに比例して時間がかかるため、
/// 圧縮対象が実際に読める場所にあるかを、書き始める前に確かめる。
///
/// collect_sources は「ファイルでもディレクトリでもないもの」を黙って捨てる。
/// そのため次の2つが、成功したように見えて中身の無い（または欠けた）
/// アーカイブになっていた:
///   - 端末（MTP）上のファイルを選んで圧縮した場合。mtp:// は通常の
///     ファイルシステムに存在しないので全件が捨てられ、空の zip ができる。
///   - USB やカードを圧縮の直前に抜いた場合。消えたぶんだけ黙って欠ける。
///
/// 呼び出し側（CompressDialog）は成功なら閉じるだけで件数を見ないため、
/// ここで止めないと利用者は空のアーカイブを掴んだまま元を消しかねない。
fn check_compress_sources(sources: &[String]) -> Result<(), String> {
    if sources.is_empty() {
        return Err("圧縮するファイルが指定されていません".to_string());
    }
    let mtp: Vec<&str> = sources
        .iter()
        .filter(|s| crate::mtp_commands::is_mtp_path(s))
        .map(|s| s.as_str())
        .collect();
    if !mtp.is_empty() {
        return Err(format!(
            "端末（MTP）上のファイルは直接圧縮できません。先にローカルへ取り出してください: {}",
            mtp.join(", ")
        ));
    }
    let missing: Vec<&str> = sources
        .iter()
        .filter(|s| !Path::new(s).exists())
        .map(|s| s.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "圧縮対象が見つかりません（取り外された可能性があります）: {}",
            missing.join(", ")
        ));
    }
    Ok(())
}

// メインスレッドを塞がないようバックグラウンドで実行する。
#[tauri::command(async)]
pub fn compress(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, CancelState>,
    sources: Vec<String>,
    dest: String,
    format: ArchiveFormat,
) -> Result<ArchiveResult, String> {
    check_compress_sources(&sources)?;
    let src_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let dest_path = PathBuf::from(&dest);

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let all_files = collect_sources(&src_paths);
    let total = all_files.len();
    let flag = cancel.begin();

    // Emit initial progress
    let _ = app.emit("compress-progress", ProgressPayload {
                        bytes_done: 0,
                        bytes_total: 0,
                        current:0,
        total,
        file: String::new(),
        done: false,
    });

    let (file_count, size) = match format {
        ArchiveFormat::Zip => create_zip_progress(&src_paths, &dest_path, &app, &flag, total)?,
        ArchiveFormat::TarGz => {
            // tar.gz: emit coarse progress (start/done only)
            let r = create_tar_gz(&src_paths, &dest_path)?;
            r
        }
        ArchiveFormat::Zstd => {
            let r = create_zstd(&src_paths, &dest_path)?;
            r
        }
    };

    cancel.end();
    let _ = app.emit("compress-progress", ProgressPayload {
                        bytes_done: 0,
                        bytes_total: 0,
                        current:file_count,
        total: file_count,
        file: String::new(),
        done: true,
    });

    Ok(ArchiveResult {
        path: dest,
        file_count,
        size,
    })
}

/// ZIP compression with per-file progress events.
fn create_zip_progress(
    sources: &[PathBuf],
    dest: &Path,
    app: &tauri::AppHandle,
    cancel_flag: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    total: usize,
) -> Result<(usize, u64), String> {
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(BufWriter::new(file));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut count = 0usize;

    for source in sources {
        if source.is_dir() {
            let base = source.parent().unwrap_or(Path::new(""));
            for entry in JWalkDir::new(source)
                .sort(true)
                .skip_hidden(false)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if cancel_flag.load(Ordering::Relaxed) {
                    drop(zip);
                    let _ = std::fs::remove_file(dest);
                    return Err("キャンセルされました".to_string());
                }
                let path = entry.path();
                let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if path.is_dir() {
                    zip.add_directory(&rel_str, options).map_err(|e| e.to_string())?;
                } else {
                    let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let _ = app.emit("compress-progress", ProgressPayload {
                        bytes_done: 0,
                        bytes_total: 0,
                        current:count,
                        total,
                        file: file_name,
                        done: false,
                    });
                    zip.start_file(&rel_str, options).map_err(|e| e.to_string())?;
                    let mut f = File::open(path).map_err(|e| e.to_string())?;
                    std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
                    count += 1;
                }
            }
        } else {
            if cancel_flag.load(Ordering::Relaxed) {
                drop(zip);
                let _ = std::fs::remove_file(dest);
                return Err("キャンセルされました".to_string());
            }
            let name = source.file_name().ok_or("ファイル名が取得できません")?.to_string_lossy();
            let _ = app.emit("compress-progress", ProgressPayload {
                        bytes_done: 0,
                        bytes_total: 0,
                        current:count,
                total,
                file: name.to_string(),
                done: false,
            });
            zip.start_file(name.as_ref(), options).map_err(|e| e.to_string())?;
            let mut f = File::open(source).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
            count += 1;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    let size = dest.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((count, size))
}

#[tauri::command(async)]
pub fn decompress(src: String, dest_dir: String) -> Result<usize, String> {
    let src_path = Path::new(&src);
    let dest = Path::new(&dest_dir);
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "zip" {
        extract_zip(src_path, dest)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz(src_path, dest)
    } else if ext == "zst" || ext == "zstd" {
        extract_zstd(src_path, dest)
    } else {
        Err(format!("未対応の形式です: .{}", ext))
    }
}

// ── Archive Browse ───────────────────────────────────────────────────────────

use crate::fs_commands::FileEntry;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,       // path inside the archive (e.g. "dir/file.txt")
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command(async)]
pub fn list_archive(path: String) -> Result<Vec<ArchiveEntry>, String> {
    let p = Path::new(&path);
    let name = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    let ext = p.extension().unwrap_or_default().to_string_lossy().to_lowercase();

    if ext == "zip" {
        let file = File::open(p).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for i in 0..archive.len() {
            let file = archive.by_index(i).map_err(|e| e.to_string())?;
            let entry_name = file.name().to_string();
            let is_dir = entry_name.ends_with('/');
            let bare_name = entry_name.trim_end_matches('/').split('/').last().unwrap_or("").to_string();
            entries.push(ArchiveEntry {
                path: entry_name.clone(),
                name: bare_name,
                is_dir,
                size: file.size(),
            });
        }
        Ok(entries)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let file = File::open(p).map_err(|e| e.to_string())?;
        let gz = GzDecoder::new(BufReader::new(file));
        let mut archive = tar::Archive::new(gz);
        let mut entries = Vec::new();
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let entry_path = entry.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
            let is_dir = entry.header().entry_type().is_dir();
            let size = entry.header().size().unwrap_or(0);
            let bare_name = entry_path.trim_end_matches('/').split('/').last().unwrap_or("").to_string();
            entries.push(ArchiveEntry {
                path: entry_path,
                name: bare_name,
                is_dir,
                size,
            });
        }
        Ok(entries)
    } else {
        Err(format!("アーカイブ閲覧は ZIP / tar.gz のみ対応: .{}", ext))
    }
}

#[allow(dead_code)]
fn _dummy_file_entry(_e: FileEntry) {} // keep import used

#[cfg(test)]
mod tests {
    use super::{check_compress_sources, collect_sources};
    use std::path::PathBuf;

    /// テスト用の一時ディレクトリ。外部クレートを足さずに済ませるため自前で用意する。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir()
                .join(format!("shirube-archive-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).expect("create temp dir");
            TempDir(base)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn accepts_sources_that_exist() {
        let tmp = TempDir::new("ok");
        let f = tmp.0.join("a.txt");
        std::fs::write(&f, b"a").unwrap();
        assert!(check_compress_sources(&s(&[f.to_str().unwrap()])).is_ok());
    }

    #[test]
    fn refuses_mtp_sources() {
        // 端末上のファイルは通常のファイルシステムに無いため collect_sources に
        // 黙って捨てられ、中身ゼロの zip が「成功」として作られていた。
        let e = check_compress_sources(&s(&["mtp://Apple iPhone/Internal Storage/a.jpg"]))
            .unwrap_err();
        assert!(e.contains("MTP"), "理由の分かるメッセージになっていない: {e}");
    }

    #[test]
    fn refuses_sources_that_disappeared() {
        // 圧縮の直前に USB を抜いた場合。欠けたまま成功するより止める。
        let tmp = TempDir::new("gone");
        let present = tmp.0.join("here.txt");
        std::fs::write(&present, b"x").unwrap();
        let gone = tmp.0.join("removed.txt");

        let e = check_compress_sources(&s(&[
            present.to_str().unwrap(),
            gone.to_str().unwrap(),
        ]))
        .unwrap_err();
        assert!(e.contains("removed.txt"), "欠けたパスを示していない: {e}");
    }

    #[test]
    fn refuses_an_empty_selection() {
        assert!(check_compress_sources(&[]).is_err());
    }

    /// 上のガードが要る理由そのもの: collect_sources は存在しないパスを
    /// エラーにせず黙って落とす。
    #[test]
    fn collect_sources_silently_drops_what_it_cannot_see() {
        let missing = vec![PathBuf::from("mtp://Apple iPhone/Internal Storage/a.jpg")];
        assert!(collect_sources(&missing).is_empty());
    }
}
