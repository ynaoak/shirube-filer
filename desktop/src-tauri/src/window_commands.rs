/// Set the native window title bar (caption) background color.
/// On non-Windows platforms this is a no-op.
#[tauri::command]
pub fn set_title_bar_color(window: tauri::WebviewWindow, r: u8, g: u8, b: u8) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR};

        let hwnd_raw = {
            let handle = window.window_handle().map_err(|e| e.to_string())?;
            match handle.as_raw() {
                RawWindowHandle::Win32(h) => h.hwnd.get(),
                _ => return Err("Not a Win32 window".to_string()),
            }
        };
        let hwnd = HWND(hwnd_raw as *mut _);
        // DWM COLORREF format: 0x00BBGGRR
        let color: u32 = (b as u32) << 16 | (g as u32) << 8 | r as u32;
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_CAPTION_COLOR,
                &color as *const _ as *const _,
                std::mem::size_of::<u32>() as u32,
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        let _ = (window, r, g, b);
        Ok(())
    }
}

/// 実行中の OS 名を返す（"windows" / "macos" / "linux" など）。
/// UI のネイティブ風スタイル切替に使う。
#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

// ── タブの切り離し（ウィンドウ間タブ D&D） ─────────────────────────────────

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

/// 切り離したタブを、生成予定の子ウィンドウ label をキーに一時保管する。
/// 子ウィンドウ側は起動直後に `take_tearoff` で取り出してレイアウトの種にする。
#[derive(Default)]
pub struct TearoffStash(pub Mutex<HashMap<String, String>>);

/// タブ（JSON 文字列）を label に紐づけて保管する。
#[tauri::command]
pub fn stash_tearoff(state: tauri::State<TearoffStash>, label: String, tab: String) {
    if let Ok(mut map) = state.0.lock() {
        map.insert(label, tab);
    }
}

/// label に紐づくタブ（JSON 文字列）を取り出して削除する。無ければ None。
#[tauri::command]
pub fn take_tearoff(state: tauri::State<TearoffStash>, label: String) -> Option<String> {
    state.0.lock().ok().and_then(|mut map| map.remove(&label))
}

/// OS カーソル座標（物理px）と、その位置にあるアプリウィンドウの label を返す。
/// `exclude` に指定した label（ドラッグ元）自身は無視する。
/// ウィンドウ間タブ D&D で「別ウィンドウに落としたか / 何も無い所に落としたか」を判定する。
#[derive(serde::Serialize)]
pub struct CursorHit {
    label: Option<String>,
    x: f64,
    y: f64,
}

#[tauri::command]
pub fn window_at_cursor(app: tauri::AppHandle, exclude: String) -> Result<CursorHit, String> {
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let mut hit: Option<String> = None;
    for (label, win) in app.webview_windows() {
        if label == exclude {
            continue;
        }
        // タブを受け取れるのはメイン系ウィンドウ（"main" / "main-*"）のみ。
        // 設定などのユーティリティウィンドウは対象外にしてタブの消失を防ぐ。
        if label != "main" && !label.starts_with("main-") {
            continue;
        }
        if !win.is_visible().unwrap_or(false) {
            continue;
        }
        let pos = match win.outer_position() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let size = match win.outer_size() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let left = pos.x as f64;
        let top = pos.y as f64;
        let right = left + size.width as f64;
        let bottom = top + size.height as f64;
        if cursor.x >= left && cursor.x < right && cursor.y >= top && cursor.y < bottom {
            hit = Some(label);
            break;
        }
    }
    Ok(CursorHit {
        label: hit,
        x: cursor.x,
        y: cursor.y,
    })
}

/// OS のアクセントカラーを "#RRGGBB" で返す。取得できない場合は None。
/// Windows: レジストリ HKCU\...\DWM\ColorizationColor（0xAARRGGBB）から算出。
#[tauri::command]
pub fn get_os_accent_color() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Registry::{
            RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
        };
        use windows::core::w;

        let mut value: u32 = 0;
        let mut size: u32 = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Windows\\DWM"),
                w!("ColorizationColor"),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut _),
                Some(&mut size),
            )
        };
        if status.is_ok() {
            // ColorizationColor は 0xAARRGGBB。
            let r = (value >> 16) & 0xFF;
            let g = (value >> 8) & 0xFF;
            let b = value & 0xFF;
            return Some(format!("#{:02X}{:02X}{:02X}", r, g, b));
        }
        return None;
    }
    #[allow(unreachable_code)]
    {
        None
    }
}
