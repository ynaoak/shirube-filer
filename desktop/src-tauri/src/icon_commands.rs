//! ファイルに同梱（埋め込み）されたアイコンの抽出。
//!
//! Windows の exe / lnk / ico 等はファイル自身にアイコンを埋め込んでおり、
//! エクスプローラーはそれを表示する。当アプリでは拡張子ベースの汎用アイコンに
//! フォールバックしていたため、exe が実行ファイルの見分けにくい既定アイコンで
//! 表示される問題があった。ここでは OS シェルから実アイコンを取得し、PNG の
//! data URL として返す。取得できない場合は None を返し、フロント側の拡張子
//! アイコンにフォールバックする。
//!
//! 非 Windows では常に None を返す（ELF 等はアイコンを埋め込まないため）。

/// ファイルの同梱アイコンを PNG の data URL として返す。
/// 取得できなければ `Ok(None)`（呼び出し側は拡張子アイコンにフォールバック）。
#[tauri::command(async)]
pub fn get_embedded_icon(path: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        match win::extract_icon_png(&path) {
            Ok(png) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                Ok(Some(format!("data:image/png;base64,{b64}")))
            }
            Err(_) => Ok(None),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(None)
    }
}

/// 拡張子（またはフォルダ）を代表する OS シェルのアイコンを PNG の data URL で返す。
///
/// Windows エクスプローラーと同じ絵柄（拡張子の関連付けアイコン、フォルダ等）を
/// 一覧に出すためのもの。実ファイルではなく「属性 + 名前」からアイコンを引く
/// （SHGFI_USEFILEATTRIBUTES）ので、ディスクアクセスが無く、呼び出し側は拡張子
/// 単位でキャッシュできる。個別アイコンを持つ exe / lnk などは
/// `get_embedded_icon`（パス単位）を使う。
#[tauri::command(async)]
pub fn get_file_type_icon(extension: String, is_dir: bool) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        // 拡張子は英数字などに限定する（パス区切りや NUL を混ぜられないように）。
        if !is_dir && !extension.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Ok(None);
        }
        match win::extract_type_icon_png(&extension, is_dir) {
            Ok(png) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                Ok(Some(format!("data:image/png;base64,{b64}")))
            }
            Err(_) => Ok(None),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (extension, is_dir);
        Ok(None)
    }
}

// ── PNG エンコード（依存追加を避けるため flate2 + 自前 CRC32 で最小実装）──────
// Windows でのみ使用するためガードして未使用警告を避ける。
#[cfg(target_os = "windows")]
fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    let stride = (w * 4) as usize;
    // 各スキャンラインの先頭にフィルタバイト(0=None)を付けた生データ列。
    let mut raw = Vec::with_capacity((h as usize) * (stride + 1));
    for y in 0..h as usize {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]);
    }
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(&raw).map_err(|e| e.to_string())?;
    let idat = enc.finish().map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // color type: truecolor + alpha (RGBA)
    ihdr.push(0); // compression
    ihdr.push(0); // filter
    ihdr.push(0); // interlace
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"IDAT", &idat);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

#[cfg(target_os = "windows")]
fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc = 0xFFFF_FFFFu32;
    for &b in kind.iter().chain(data.iter()) {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    out.extend_from_slice(&(!crc).to_be_bytes());
}

#[cfg(target_os = "windows")]
mod win {
    use super::encode_png;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// ファイルの同梱アイコンを取得し PNG バイト列にエンコードして返す。
    pub fn extract_icon_png(path: &str) -> Result<Vec<u8>, String> {
        let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
        unsafe {
            let mut shfi = SHFILEINFOW::default();
            let res = SHGetFileInfoW(
                PCWSTR(wide.as_ptr()),
                Default::default(),
                Some(&mut shfi),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            );
            if res == 0 || shfi.hIcon.is_invalid() {
                return Err("SHGetFileInfoW returned no icon".into());
            }
            let hicon = shfi.hIcon;
            let out = hicon_to_png(hicon);
            let _ = DestroyIcon(hicon);
            out
        }
    }

    /// 拡張子（またはフォルダ）を代表するアイコンを取得する。
    /// SHGFI_USEFILEATTRIBUTES により実在しないパスでもよいので、ディスクを
    /// 触らずに「その種別のアイコン」を引ける。
    pub fn extract_type_icon_png(extension: &str, is_dir: bool) -> Result<Vec<u8>, String> {
        use windows::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
        };
        use windows::Win32::UI::Shell::SHGFI_USEFILEATTRIBUTES;

        // 実体は参照されないため、種別を表すだけのダミー名でよい。
        let name = if is_dir {
            "folder".to_string()
        } else if extension.is_empty() {
            "file".to_string()
        } else {
            format!("file.{extension}")
        };
        let wide: Vec<u16> = OsStr::new(&name).encode_wide().chain(Some(0)).collect();
        let attrs = if is_dir { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_NORMAL };

        unsafe {
            let mut shfi = SHFILEINFOW::default();
            let res = SHGetFileInfoW(
                PCWSTR(wide.as_ptr()),
                attrs,
                Some(&mut shfi),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
            );
            if res == 0 || shfi.hIcon.is_invalid() {
                return Err("SHGetFileInfoW returned no icon".into());
            }
            let hicon = shfi.hIcon;
            let out = hicon_to_png(hicon);
            let _ = DestroyIcon(hicon);
            out
        }
    }

    unsafe fn hicon_to_png(hicon: HICON) -> Result<Vec<u8>, String> {
        let mut ii = ICONINFO::default();
        GetIconInfo(hicon, &mut ii).map_err(|e| e.to_string())?;
        let hbm_color = ii.hbmColor;
        let hbm_mask = ii.hbmMask;

        let cleanup = || {
            let _ = DeleteObject(HGDIOBJ(hbm_color.0));
            let _ = DeleteObject(HGDIOBJ(hbm_mask.0));
        };

        let mut bm = BITMAP::default();
        let got = GetObjectW(
            HGDIOBJ(hbm_color.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
            cleanup();
            return Err("GetObjectW failed".into());
        }
        let w = bm.bmWidth;
        let h = bm.bmHeight;

        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            cleanup();
            return Err("CreateCompatibleDC failed".into());
        }

        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // 負値 = top-down（上から下の行順）
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0 as u32;

        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            hdc,
            hbm_color,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            let _ = DeleteDC(hdc);
            cleanup();
            return Err("GetDIBits(color) failed".into());
        }

        // 一部の古いアイコンは色ビットマップにアルファを持たない。全画素の
        // アルファが 0 ならマスクビットマップから不透明度を復元する。
        let has_alpha = pixels.chunks_exact(4).any(|p| p[3] != 0);
        if !has_alpha {
            let mut mask = vec![0u8; (w * h * 4) as usize];
            let mut bi2 = bi;
            let mlines = GetDIBits(
                hdc,
                hbm_mask,
                0,
                h as u32,
                Some(mask.as_mut_ptr() as *mut _),
                &mut bi2,
                DIB_RGB_COLORS,
            );
            for i in 0..(w * h) as usize {
                // マスクは白(≠0)=透過 / 黒(0)=不透明。取得失敗時は全不透明。
                let transparent = mlines != 0 && mask[i * 4] != 0;
                pixels[i * 4 + 3] = if transparent { 0 } else { 255 };
            }
        }

        // GetDIBits は BGRA 順で返すため RGBA に並べ替える。
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
        }

        let _ = DeleteDC(hdc);
        cleanup();

        encode_png(w as u32, h as u32, &pixels)
    }
}
