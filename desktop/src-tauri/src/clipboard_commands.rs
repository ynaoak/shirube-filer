use serde::Serialize;

// ── OS クリップボードのファイルリスト連携 ────────────────────────────────────
// エクスプローラー等の他アプリでコピー/カットしたファイルを shirube-filer に
// 貼り付けられるようにし、逆にアプリ内のコピー/カットも OS クリップボードへ
// 反映してエクスプローラー側で貼り付けられるようにする。
// Windows は CF_HDROP（ファイルリスト）と "Preferred DropEffect"（copy/move 区別）
// を読み書きする。macOS / Linux は未対応（get は None、set/clear は no-op）で、
// その場合フロントはアプリ内クリップボードのみで動作する。

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFiles {
    pub paths: Vec<String>,
    pub cut: bool,
}

/// OS クリップボードからファイルリストを読み取る。ファイルが載っていなければ None。
/// クリップボードのオープンは他プロセスと競合してリトライ待ちが発生するため、
/// メインスレッドを止めないようバックグラウンドスレッドで実行する。
#[tauri::command(async)]
pub fn clipboard_get_file_list() -> Result<Option<ClipboardFiles>, String> {
    imp::get_file_list()
}

/// アプリ内のコピー/カットを OS クリップボードへも反映する。
#[tauri::command(async)]
pub fn clipboard_set_file_list(paths: Vec<String>, cut: bool) -> Result<(), String> {
    imp::set_file_list(&paths, cut)
}

/// 切り取り→貼り付け完了後に OS クリップボードを空にする（エクスプローラーと同じ挙動）。
/// ファイルリスト以外（テキスト等）が載っている場合は何もしない。
#[tauri::command(async)]
pub fn clipboard_clear_file_list() -> Result<(), String> {
    imp::clear_file_list()
}

#[cfg(windows)]
mod imp {
    use super::ClipboardFiles;
    use clipboard_win::{formats, raw, Clipboard, Getter};

    const CF_HDROP: u32 = formats::CF_HDROP;
    const DROPEFFECT_COPY: u32 = 1;
    const DROPEFFECT_MOVE: u32 = 2;
    const DROPEFFECT_LINK: u32 = 4;
    /// 他プロセスがクリップボードを掴んでいる場合に備えたオープン再試行回数。
    const OPEN_ATTEMPTS: usize = 10;

    pub fn get_file_list() -> Result<Option<ClipboardFiles>, String> {
        // 形式チェックはクリップボードを開かずに行える
        if !clipboard_win::is_format_avail(CF_HDROP) {
            return Ok(None);
        }
        let _clip = Clipboard::new_attempts(OPEN_ATTEMPTS)
            .map_err(|e| format!("クリップボードを開けません: {}", e))?;
        let mut paths: Vec<String> = Vec::new();
        if formats::FileList.read_clipboard(&mut paths).is_err() || paths.is_empty() {
            return Ok(None);
        }
        // 「切り取り」判定: Preferred DropEffect に MOVE が立っていて COPY が無い場合。
        // エクスプローラーはコピー時 5 (COPY|LINK)、切り取り時 2 (MOVE) を書き込む。
        let mut cut = false;
        if let Some(fmt) = clipboard_win::register_format("Preferred DropEffect") {
            let mut buf: Vec<u8> = Vec::new();
            if raw::get_vec(fmt.get(), &mut buf).is_ok() && buf.len() >= 4 {
                let effect = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
                cut = effect & DROPEFFECT_MOVE != 0 && effect & DROPEFFECT_COPY == 0;
            }
        }
        Ok(Some(ClipboardFiles { paths, cut }))
    }

    pub fn set_file_list(paths: &[String], cut: bool) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let _clip = Clipboard::new_attempts(OPEN_ATTEMPTS)
            .map_err(|e| format!("クリップボードを開けません: {}", e))?;
        raw::empty().map_err(|e| format!("クリップボードの初期化に失敗: {}", e))?;
        raw::set_file_list(paths).map_err(|e| format!("ファイルリストの書き込みに失敗: {}", e))?;
        // エクスプローラーが copy / move を区別できるよう Preferred DropEffect を併記する。
        // 書き込めなくてもファイルリスト自体は有効なのでエラーにしない。
        if let Some(fmt) = clipboard_win::register_format("Preferred DropEffect") {
            let effect: u32 = if cut { DROPEFFECT_MOVE } else { DROPEFFECT_COPY | DROPEFFECT_LINK };
            let _ = raw::set_without_clear(fmt.get(), &effect.to_le_bytes());
        }
        Ok(())
    }

    pub fn clear_file_list() -> Result<(), String> {
        if !clipboard_win::is_format_avail(CF_HDROP) {
            return Ok(());
        }
        let _clip = Clipboard::new_attempts(OPEN_ATTEMPTS)
            .map_err(|e| format!("クリップボードを開けません: {}", e))?;
        raw::empty().map_err(|e| format!("クリップボードのクリアに失敗: {}", e))?;
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::ClipboardFiles;

    pub fn get_file_list() -> Result<Option<ClipboardFiles>, String> {
        Ok(None)
    }

    pub fn set_file_list(_paths: &[String], _cut: bool) -> Result<(), String> {
        Ok(())
    }

    pub fn clear_file_list() -> Result<(), String> {
        Ok(())
    }
}
