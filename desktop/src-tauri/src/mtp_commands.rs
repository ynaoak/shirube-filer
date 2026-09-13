//! MTP（Media Transfer Protocol）対応 — スマートフォン/カメラ等のポータブル
//! デバイスを Windows Portable Devices (WPD) API 経由で閲覧・ダウンロードする。
//!
//! これらの端末はドライブレターを持たず通常のファイルシステムには現れないため、
//! `mtp://<デバイス名>/<フォルダ名>/...` という仮想パスで表現し、`read_dir`
//! から本モジュールへ委譲する。フロントはパスを不透明な文字列として扱うため、
//! 一覧・履歴・パンくずはそのまま流用できる。
//!
//! 対応範囲（第一弾）: デバイス列挙・フォルダ/ファイル閲覧・端末→PC への
//! ダウンロード（読み取り専用）。書き込み系は行わない。
//! 非 Windows では常にエラー（対象外）。

use crate::fs_commands::ReadDirResult;
use crate::progress::CancelState;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MtpDevice {
    /// デバイスのフレンドリ名（`mtp://<name>` のキーとして用いる）
    pub name: String,
}

/// `mtp://` スキームのパスかどうか。
pub fn is_mtp_path(path: &str) -> bool {
    path.starts_with("mtp://")
}

/// `mtp://<device>/<seg>/<seg>...` を (デバイス名, [セグメント]) に分解する。
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_mtp_path(path: &str) -> Option<(String, Vec<String>)> {
    let rest = path.strip_prefix("mtp://")?;
    let mut parts = rest.split('/').filter(|s| !s.is_empty());
    let device = parts.next()?.to_string();
    let segments: Vec<String> = parts.map(|s| s.to_string()).collect();
    Some((device, segments))
}

/// 取り出し先パスの検査。
///
/// ここは信用できない入力の出口になる。取り出し先のファイル名は元をたどると
/// 端末が申告した名前（WPD_OBJECT_ORIGINAL_FILE_NAME）で、こちらの検証を
/// 通っていない。壊れた端末や細工した端末が変な名前を返すと、そのまま
/// File::create の宛先になってしまう。
///
/// rename_item が利用者の入力に対して同じ検査をしているのに対し、こちらは
/// 素通しだった。危ないのは主に Windows で:
///   - `NUL` `CON` `COM1` 等の予約名 → 書き込みが成功したまま中身が消える
///   - `x.txt:hidden` → 代替データストリーム（ADS）として不可視の場所に書く
///   - 末尾のドット/空白 → OS が黙って落とすため、一覧の表示名と実際に
///     できるファイル名がずれる（`evil.exe.` と見せて `evil.exe` を作る）
fn validate_download_dest(dest: &str) -> Result<(), String> {
    if dest.contains('\0') {
        return Err("パスにNULLバイトは使用できません".to_string());
    }
    if !std::path::Path::new(dest).is_absolute() {
        return Err(format!("絶対パスを指定してください: {}", dest));
    }
    // 末尾の要素（＝作られるファイル名）だけを見る。親ディレクトリは利用者が
    // 選んだ実在のフォルダで、端末由来ではない。
    let name = dest.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or("");
    validate_download_name(name)
}

/// 取り出しで作られるファイル名そのものの検査。
///
/// `validate_download_dest` から切り出してあるのは、パスの絶対判定が OS で
/// 変わる（Unix では `C:\...` は絶対パスではない）ため。名前の危険性は OS に
/// よらず同じ基準で見たいし、そうしないと Windows 以外でテストしたときに
/// 「絶対パスでない」という別の理由で弾かれ、検査が効いているのか分からない。
fn validate_download_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(format!("取り出し先のファイル名が不正です: {}", name));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(format!(
            "取り出し先のファイル名の末尾にドットや空白は使用できません: {}",
            name
        ));
    }
    // ADS 指定。Windows 以外でも受け付けない（端末を挿す OS を選ばず同じ結果にする）。
    if name.contains(':') {
        return Err(format!("取り出し先のファイル名に ':' は使用できません: {}", name));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Err(format!("取り出し先に予約デバイス名は使用できません: {}", name));
    }
    Ok(())
}

/// 取り出しを始める前の確認。プラットフォーム分岐の外に置いてあるのは、
/// ここに来る名前が端末の申告どおりでこちらの検証を通っていないため、
/// どの OS でも同じ基準で見たいから。
fn preflight_download(dest: &str, overwrite: bool) -> Result<(), String> {
    validate_download_dest(dest)?;
    // 上書きは呼び出し側が明示したときだけ。取り出し先の衝突はフロントの
    // 衝突ダイアログが拾うが、それはディスク上の既存しか見ていない。同じ
    // 一括処理の中で宛先が重なると素通りして後勝ちで消えていた。
    //
    // 重なるのは、大文字小文字だけが異なる名前が同じフォルダに並ぶとき
    // （Android 等の大小を区別する端末で起こる。Windows 側は区別しないため
    // 同じ取り出し先になる）。iOS は大小を区別しないので、この重なりは
    // 起きない。いずれにせよ書き込む直前のここで守っておく。
    if !overwrite && std::path::Path::new(dest).exists() {
        return Err(format!("取り出し先がすでに存在します: {}", dest));
    }
    Ok(())
}

/// 端末の表示名が重複しないよう、2 台目以降に連番を付けて返す。
///
/// 仮想パス `mtp://<表示名>/...` は表示名だけで端末を指す。同じ機種を 2 台
/// 挿すと WPD のフレンドリ名がどちらも "Apple iPhone" になり、一覧には同じ
/// 項目が 2 つ並ぶ一方、開くときは常に先に見つかったほうに解決されていた。
/// 2 台目の中身が見られないだけでなく、どちらを選んでも同じ端末が開くため
/// 取り違えに気付けない。
fn disambiguate_device_names(names: &[String]) -> Vec<String> {
    let mut seen: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    names
        .iter()
        .map(|n| {
            let c = seen.entry(n.as_str()).or_insert(0);
            *c += 1;
            if *c == 1 {
                n.clone()
            } else {
                format!("{n} ({c})")
            }
        })
        .collect()
}

/// 表示名（連番付きかもしれない）から、対応する端末の位置を選ぶ。
///
/// 連番を付けた名前と、元々その綴りを持つ端末が両方ありうるので、
/// まず表示名そのものの完全一致を見る。
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_device_index(names: &[String], label: &str) -> Result<usize, String> {
    let labels = disambiguate_device_names(names);
    labels
        .iter()
        .position(|l| l == label)
        .ok_or_else(|| format!("MTP デバイスが見つかりません: {label}"))
}

/// 子オブジェクトの名前一覧から、パスの 1 セグメントに対応するものを選ぶ。
///
/// 端末のファイルシステム（Android の内部ストレージ等）は大小を区別するため、
/// 同じフォルダに `Photo.JPG` と `photo.jpg` が並んで存在しうる。以前は
/// `eq_ignore_ascii_case` で最初に見つかったものを返していたので、片方を選んだ
/// つもりでもう片方の中身が取り出される（しかも何の警告も出ない）ことがあった。
///
/// 完全一致を最優先する。完全一致が無いときだけ大小無視で拾い、それが複数
/// あるなら「どれか」を返さずエラーにする。取り違えて黙って別の中身を渡すより、
/// 取り出せないほうがまだ良い。
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_child_index(names: &[String], seg: &str) -> Result<usize, String> {
    if let Some(i) = names.iter().position(|n| n == seg) {
        return Ok(i);
    }
    let mut it = names
        .iter()
        .enumerate()
        .filter(|(_, n)| n.eq_ignore_ascii_case(seg));
    match (it.next(), it.next()) {
        (None, _) => Err(format!("見つかりません: {seg}")),
        (Some((i, _)), None) => Ok(i),
        (Some(_), Some(_)) => Err(format!(
            "大文字小文字だけが異なる同名のファイルが複数あります。取り違えを避けるため取り出しを中止しました: {seg}"
        )),
    }
}

// ── 接続されている MTP デバイスの列挙 ─────────────────────────────────────
#[tauri::command(async)]
pub fn mtp_list_devices() -> Result<Vec<MtpDevice>, String> {
    #[cfg(windows)]
    {
        win::list_devices()
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// `mtp://` パスのディレクトリ内容を列挙する（`read_dir` から委譲される）。
pub fn read_dir(path: &str) -> Result<ReadDirResult, String> {
    #[cfg(windows)]
    {
        win::read_dir(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("MTP はこのプラットフォームでは対応していません".into())
    }
}

/// MTP 上のファイルをローカル (`dest`) へダウンロードする。
///
/// 端末からの取り出しは USB 越しで、動画 1 本に分単位かかることもある。その間
/// 操作キューに「実行中」としか出ないと本当に進んでいるのか分からないため、
/// 通常のコピーと同じ `copy-progress` イベントを流して割合を出せるようにする。
#[tauri::command(async)]
pub fn mtp_download(
    app: tauri::AppHandle,
    cancel: tauri::State<'_, CancelState>,
    path: String,
    dest: String,
    overwrite: bool,
) -> Result<(), String> {
    preflight_download(&dest, overwrite)?;
    #[cfg(windows)]
    {
        let flag = cancel.begin();
        win::download(&app, &flag, &path, &dest)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, cancel, path, dest);
        Err("MTP はこのプラットフォームでは対応していません".into())
    }
}

#[cfg(windows)]
mod win {
    use super::{parse_mtp_path, MtpDevice, ReadDirResult};
    use crate::fs_commands::FileEntry;
    use crate::progress::ProgressPayload;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::Emitter;
    use windows::core::{GUID, PCWSTR, PWSTR};
    use windows::Win32::Devices::PortableDevices::{
        IEnumPortableDeviceObjectIDs, IPortableDevice, IPortableDeviceContent,
        IPortableDeviceKeyCollection, IPortableDeviceManager, IPortableDeviceProperties,
        IPortableDeviceValues, PortableDevice, PortableDeviceKeyCollection, PortableDeviceManager,
        PortableDeviceValues, WPD_CONTENT_TYPE_FOLDER, WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT,
        WPD_DEVICE_OBJECT_ID, WPD_OBJECT_CONTENT_TYPE, WPD_OBJECT_NAME,
        WPD_OBJECT_ORIGINAL_FILE_NAME, WPD_OBJECT_SIZE, WPD_RESOURCE_DEFAULT,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IStream, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    /// 進捗イベントの最短送信間隔。チャンクごとに emit すると IPC とフロントの
    /// 再描画が詰まるため、file_ops と同じ考え方で間引く。
    const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

    /// UTF-16 の NUL 終端バッファ（PCWSTR 用に生存させる）。
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// 呼び出し側が確保した PWSTR を Rust 文字列へ複製し、CoTaskMemFree で解放する。
    unsafe fn take_pwstr(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        let s = p.to_string().unwrap_or_default();
        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
        s
    }

    fn ensure_com() {
        unsafe {
            // MTA で初期化。既に初期化済み（RPC_E_CHANGED_MODE 等）でも問題ない。
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    pub fn list_devices() -> Result<Vec<MtpDevice>, String> {
        ensure_com();
        unsafe {
            let manager: IPortableDeviceManager =
                CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| e.to_string())?;

            // まず件数を取得（第 1 引数 null）。
            let mut count: u32 = 0;
            manager
                .GetDevices(std::ptr::null_mut(), &mut count)
                .map_err(|e| e.to_string())?;
            if count == 0 {
                return Ok(Vec::new());
            }
            let mut ids: Vec<PWSTR> = vec![PWSTR::null(); count as usize];
            manager
                .GetDevices(ids.as_mut_ptr(), &mut count)
                .map_err(|e| e.to_string())?;

            let mut names = Vec::new();
            for id in ids.into_iter().take(count as usize) {
                let name = device_friendly_name(&manager, id);
                // id 自体は CoTaskMemFree で解放。
                windows::Win32::System::Com::CoTaskMemFree(Some(id.0 as *const _));
                if !name.is_empty() {
                    names.push(name);
                }
            }
            // 同じ機種を 2 台挿すとフレンドリ名が衝突する。仮想パスは表示名で
            // 端末を指すため、連番を振って区別できるようにする。
            Ok(super::disambiguate_device_names(&names)
                .into_iter()
                .map(|name| MtpDevice { name })
                .collect())
        }
    }

    unsafe fn device_friendly_name(manager: &IPortableDeviceManager, id: PWSTR) -> String {
        let idc = PCWSTR(id.0);
        let mut len: u32 = 0;
        // 長さ取得（バッファ null）。
        let _ = manager.GetDeviceFriendlyName(idc, PWSTR::null(), &mut len);
        if len == 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize];
        if manager
            .GetDeviceFriendlyName(idc, PWSTR(buf.as_mut_ptr()), &mut len)
            .is_err()
        {
            return String::new();
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// フレンドリ名からデバイスを開き、(device, content, properties) を返す。
    unsafe fn open_device_by_name(
        name: &str,
    ) -> Result<(IPortableDevice, IPortableDeviceContent, IPortableDeviceProperties), String> {
        let manager: IPortableDeviceManager =
            CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        let mut count: u32 = 0;
        manager
            .GetDevices(std::ptr::null_mut(), &mut count)
            .map_err(|e| e.to_string())?;
        let mut ids: Vec<PWSTR> = vec![PWSTR::null(); count as usize];
        if count > 0 {
            manager
                .GetDevices(ids.as_mut_ptr(), &mut count)
                .map_err(|e| e.to_string())?;
        }

        // 表示名と PnP ID を並びのまま集める。表示名は重複しうるので、
        // どれを指しているかは連番込みの表示名で決める（一覧と同じ規則）。
        let mut names: Vec<String> = Vec::new();
        let mut pnp_ids: Vec<String> = Vec::new();
        for id in ids.into_iter().take(count as usize) {
            let fname = device_friendly_name(&manager, id);
            let pnp_id = id.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(id.0 as *const _));
            if !fname.is_empty() {
                names.push(fname);
                pnp_ids.push(pnp_id);
            }
        }
        let idx = super::pick_device_index(&names, name)?;
        let pnp = wide(&pnp_ids[idx]);

        let device: IPortableDevice =
            CoCreateInstance(&PortableDevice, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        let client: IPortableDeviceValues =
            CoCreateInstance(&PortableDeviceValues, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        device
            .Open(PCWSTR(pnp.as_ptr()), &client)
            .map_err(|e| e.to_string())?;
        let content = device.Content().map_err(|e| e.to_string())?;
        let properties = content.Properties().map_err(|e| e.to_string())?;
        Ok((device, content, properties))
    }

    struct ChildObject {
        object_id: String,
        name: String,
        is_dir: bool,
        size: u64,
    }

    /// 親オブジェクト直下の子オブジェクトを列挙する。
    unsafe fn enum_children(
        content: &IPortableDeviceContent,
        props: &IPortableDeviceProperties,
        parent_id: PCWSTR,
    ) -> Result<Vec<ChildObject>, String> {
        let enumerator: IEnumPortableDeviceObjectIDs = content
            .EnumObjects(0, parent_id, None)
            .map_err(|e| e.to_string())?;

        // 取得したい属性のキー集合を用意。
        let keys: IPortableDeviceKeyCollection =
            CoCreateInstance(&PortableDeviceKeyCollection, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        keys.Add(&WPD_OBJECT_NAME).map_err(|e| e.to_string())?;
        keys.Add(&WPD_OBJECT_ORIGINAL_FILE_NAME)
            .map_err(|e| e.to_string())?;
        keys.Add(&WPD_OBJECT_CONTENT_TYPE)
            .map_err(|e| e.to_string())?;
        keys.Add(&WPD_OBJECT_SIZE).map_err(|e| e.to_string())?;

        let mut result = Vec::new();
        loop {
            let mut batch: [PWSTR; 32] = [PWSTR::null(); 32];
            let mut fetched: u32 = 0;
            let _ = enumerator.Next(&mut batch, &mut fetched);
            if fetched == 0 {
                break;
            }
            for obj in batch.into_iter().take(fetched as usize) {
                if obj.is_null() {
                    continue;
                }
                let obj_id = obj.to_string().unwrap_or_default();
                windows::Win32::System::Com::CoTaskMemFree(Some(obj.0 as *const _));
                if obj_id.is_empty() {
                    continue;
                }
                let child = read_child(content, props, &keys, &obj_id);
                if let Some(c) = child {
                    result.push(c);
                }
            }
        }
        Ok(result)
    }

    unsafe fn read_child(
        _content: &IPortableDeviceContent,
        props: &IPortableDeviceProperties,
        keys: &IPortableDeviceKeyCollection,
        object_id: &str,
    ) -> Option<ChildObject> {
        let oid = wide(object_id);
        let values = props.GetValues(PCWSTR(oid.as_ptr()), keys).ok()?;

        // 種別（フォルダ or ストレージ等の機能オブジェクトはフォルダ扱い）。
        let is_dir = match values.GetGuidValue(&WPD_OBJECT_CONTENT_TYPE) {
            Ok(ct) => guid_eq(&ct, &WPD_CONTENT_TYPE_FOLDER)
                || guid_eq(&ct, &WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT),
            Err(_) => false,
        };

        // 表示名: オリジナルファイル名（拡張子付き）を優先、無ければオブジェクト名。
        let name = read_string(&values, &WPD_OBJECT_ORIGINAL_FILE_NAME)
            .filter(|s| !s.is_empty())
            .or_else(|| read_string(&values, &WPD_OBJECT_NAME))
            .unwrap_or_else(|| object_id.to_string());

        let size = values.GetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE).unwrap_or(0);

        Some(ChildObject {
            object_id: object_id.to_string(),
            name,
            is_dir,
            size,
        })
    }

    unsafe fn read_string(
        values: &IPortableDeviceValues,
        key: *const windows::Win32::Foundation::PROPERTYKEY,
    ) -> Option<String> {
        let p = values.GetStringValue(key).ok()?;
        Some(super::win::take_pwstr(p))
    }

    fn guid_eq(a: &GUID, b: &GUID) -> bool {
        a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
    }

    /// 名前セグメントを辿って対象フォルダ/ファイルのオブジェクト ID を解決する。
    unsafe fn resolve_object_id(
        content: &IPortableDeviceContent,
        props: &IPortableDeviceProperties,
        segments: &[String],
    ) -> Result<String, String> {
        // 開始はデバイスルート。
        let mut current: String = WPD_DEVICE_OBJECT_ID.to_string().unwrap_or_else(|_| "DEVICE".into());
        for seg in segments {
            let cur = wide(&current);
            let children = enum_children(content, props, PCWSTR(cur.as_ptr()))?;
            let names: Vec<String> = children.iter().map(|c| c.name.clone()).collect();
            let idx = super::pick_child_index(&names, seg)?;
            current = children.into_iter().nth(idx).unwrap().object_id;
        }
        Ok(current)
    }

    pub fn read_dir(path: &str) -> Result<ReadDirResult, String> {
        ensure_com();
        let (device_name, segments) =
            parse_mtp_path(path).ok_or_else(|| "不正な MTP パス".to_string())?;
        unsafe {
            let (_device, content, props) = open_device_by_name(&device_name)?;
            let parent_id = resolve_object_id(&content, &props, &segments)?;
            let pid = wide(&parent_id);
            let mut children = enum_children(&content, &props, PCWSTR(pid.as_ptr()))?;

            // ディレクトリ優先→名前順。
            children.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });

            let base = path.trim_end_matches('/');
            let entries: Vec<FileEntry> = children
                .into_iter()
                .map(|c| {
                    let ext = if c.is_dir {
                        None
                    } else {
                        Path::new(&c.name)
                            .extension()
                            .map(|e| e.to_string_lossy().to_string())
                    };
                    FileEntry {
                        path: format!("{base}/{}", c.name),
                        name: c.name,
                        is_dir: c.is_dir,
                        is_symlink: false,
                        is_hidden: false,
                        size: c.size,
                        modified: None,
                        extension: ext,
                    }
                })
                .collect();

            Ok(ReadDirResult {
                path: path.to_string(),
                entries,
            })
        }
    }

    /// オブジェクトのバイトサイズ。端末が返さない場合は 0（サイズ不明）。
    ///
    /// 一覧の列挙とは別に単体で引き直しているのは、resolve_object_id が辿る
    /// 途中経過ではなく最終オブジェクトの実サイズが要るため。1 回の
    /// プロパティ取得なので転送時間に対しては無視できる。
    unsafe fn object_size(props: &IPortableDeviceProperties, object_id: &str) -> u64 {
        let keys: IPortableDeviceKeyCollection =
            match CoCreateInstance(&PortableDeviceKeyCollection, None, CLSCTX_INPROC_SERVER) {
                Ok(k) => k,
                Err(_) => return 0,
            };
        if keys.Add(&WPD_OBJECT_SIZE).is_err() {
            return 0;
        }
        let oid = wide(object_id);
        match props.GetValues(PCWSTR(oid.as_ptr()), &keys) {
            Ok(v) => v.GetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE).unwrap_or(0),
            Err(_) => 0,
        }
    }

    pub fn download(
        app: &tauri::AppHandle,
        flag: &AtomicBool,
        path: &str,
        dest: &str,
    ) -> Result<(), String> {
        ensure_com();
        let (device_name, segments) =
            parse_mtp_path(path).ok_or_else(|| "不正な MTP パス".to_string())?;
        let file_name = match segments.last() {
            Some(n) => n.clone(),
            None => return Err("ダウンロード対象が指定されていません".into()),
        };
        unsafe {
            let (_device, content, props) = open_device_by_name(&device_name)?;
            let object_id = resolve_object_id(&content, &props, &segments)?;
            // 総バイト数。端末が返さないこともあり、その場合は 0 のまま流して
            // フロント側で「割合ではなく転送済みバイト数」の表示に切り替える。
            let bytes_total = object_size(&props, &object_id);
            let oid = wide(&object_id);

            let resources = content.Transfer().map_err(|e| e.to_string())?;
            let mut optimal: u32 = 0;
            let mut stream: Option<IStream> = None;
            resources
                .GetStream(
                    PCWSTR(oid.as_ptr()),
                    &WPD_RESOURCE_DEFAULT,
                    0, // STGM_READ
                    &mut optimal,
                    &mut stream,
                )
                .map_err(|e| e.to_string())?;
            let stream = stream.ok_or_else(|| "ストリームを取得できません".to_string())?;

            let buf_size = if optimal == 0 { 256 * 1024 } else { optimal as usize };
            let mut buf = vec![0u8; buf_size];
            let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
            use std::io::Write;

            let mut bytes_done: u64 = 0;
            let mut last_emit: Option<Instant> = None;
            // 読み出しが始まる前に 0% を出しておく。総バイト数が分かった時点で
            // UI をバー表示に確定させ、「実行中」だけの状態を作らない。
            let _ = app.emit(
                "copy-progress",
                ProgressPayload {
                    current: 0,
                    total: 1,
                    file: file_name.clone(),
                    done: false,
                    bytes_done: 0,
                    bytes_total,
                },
            );

            let mut cancelled = false;
            loop {
                if flag.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let mut read: u32 = 0;
                stream
                    .Read(
                        buf.as_mut_ptr() as *mut _,
                        buf.len() as u32,
                        Some(&mut read),
                    )
                    .ok()
                    .map_err(|e| e.to_string())?;
                if read == 0 {
                    break;
                }
                out.write_all(&buf[..read as usize])
                    .map_err(|e| e.to_string())?;
                bytes_done += read as u64;
                if last_emit.map_or(true, |t| t.elapsed() >= PROGRESS_INTERVAL) {
                    last_emit = Some(Instant::now());
                    let _ = app.emit(
                        "copy-progress",
                        ProgressPayload {
                            current: 0,
                            total: 1,
                            file: file_name.clone(),
                            done: false,
                            bytes_done,
                            bytes_total,
                        },
                    );
                }
            }

            if cancelled {
                // 途中まで書いたファイルは残さない。中身が欠けたまま「取り出せた」
                // ように見えるのが一番まずい。
                drop(out);
                let _ = std::fs::remove_file(dest);
                return Err("キャンセルされました".to_string());
            }

            out.flush().map_err(|e| e.to_string())?;
            let _ = app.emit(
                "copy-progress",
                ProgressPayload {
                    current: 1,
                    total: 1,
                    file: String::new(),
                    done: true,
                    bytes_done,
                    // サイズ不明のまま完了したときは、実際に読めた量を総量として扱う。
                    bytes_total: if bytes_total == 0 { bytes_done } else { bytes_total },
                },
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        disambiguate_device_names, parse_mtp_path, pick_child_index, pick_device_index,
        preflight_download, validate_download_dest, validate_download_name,
    };

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ── 取り出し先のファイル名 ──────────────────────────────────────────
    // 端末が申告した名前がそのまま書き込み先になるため、ここが最後の砦になる。
    // 名前だけを見る関数に対して検査するので、Windows 以外で走らせても
    // 「絶対パスでない」という別の理由で通ってしまうことがない。

    #[test]
    fn accepts_ordinary_file_names() {
        for name in ["IMG_0001.JPG", "動画 001.mp4", "a.tar.gz", "no-ext"] {
            assert!(validate_download_name(name).is_ok(), "弾きすぎ: {name}");
        }
    }

    /// iPhone が実際に見せる名前を弾かないこと。
    ///
    /// iOS は DCIM しか公開せず、名前は Apple 側が付けたものに限られる。
    /// 検査を強めるときに、この実在の名前まで巻き込んで取り出せなくして
    /// しまわないための歯止め。
    #[test]
    fn accepts_the_names_an_iphone_actually_reports() {
        for name in [
            "IMG_0001.JPG",
            "IMG_0001.HEIC",
            "IMG_0001.MOV",
            "IMG_0001.AAE",
            "IMG_E0001.JPG",            // 編集済み
            "IMG_1234.heic",            // 小文字で申告される場合
            "FullSizeRender.jpg",
            "IMG_0001(1).JPG",
            "IMG_0001.HEIC.icloud",     // 未ダウンロードのプレースホルダ
            "動画 001.MOV",              // 日本語・空白入り
        ] {
            assert!(
                validate_download_name(name).is_ok(),
                "iPhone の実在名を弾いてしまった: {name}"
            );
        }
    }

    #[test]
    fn rejects_windows_reserved_device_names() {
        // NUL 等へ書くと成功したように見えて中身が消える。
        for name in ["NUL", "nul", "CON", "com1", "LPT9", "NUL.txt", "aux.dat"] {
            assert!(
                validate_download_name(name).is_err(),
                "予約デバイス名を通してしまった: {name}"
            );
        }
    }

    #[test]
    fn rejects_alternate_data_streams() {
        // `notes.txt:hidden` は notes.txt の不可視ストリームに書き込まれる。
        assert!(validate_download_name("notes.txt:hidden").is_err());
    }

    #[test]
    fn rejects_trailing_dot_or_space() {
        // Windows は末尾のドット/空白を黙って落とすため、一覧の表示名と実際に
        // できるファイル名がずれる（`evil.exe.` と見せて `evil.exe` を作る）。
        assert!(validate_download_name("evil.exe.").is_err());
        assert!(validate_download_name("evil.exe ").is_err());
    }

    #[test]
    fn rejects_dot_segments_and_empty_names() {
        assert!(validate_download_name("").is_err());
        assert!(validate_download_name(".").is_err());
        assert!(validate_download_name("..").is_err());
    }

    // ── 取り出し先パス全体 ──────────────────────────────────────────────

    #[test]
    fn accepts_an_absolute_destination() {
        // 絶対パスの表記は OS で違うので、動いている OS のものを使う。
        let ok = if cfg!(windows) {
            "C:\\Users\\me\\photos\\IMG_0001.JPG"
        } else {
            "/home/user/photos/IMG_0001.JPG"
        };
        assert!(validate_download_dest(ok).is_ok(), "{ok} が弾かれた");
    }

    #[test]
    fn rejects_a_relative_destination() {
        // 相対パスはアプリの作業ディレクトリ基準で書かれてしまう。
        assert!(validate_download_dest("photos/IMG_0001.JPG").is_err());
        assert!(validate_download_dest("").is_err());
    }

    #[test]
    fn rejects_null_bytes() {
        assert!(validate_download_dest("/home/user/a\0b.jpg").is_err());
    }

    #[test]
    fn checks_only_the_last_component() {
        // 親ディレクトリは利用者が選んだ実在のフォルダなので、そこに予約名と
        // 同じ綴りがあっても構わない。見るのは作られるファイル名だけ。
        let dest = if cfg!(windows) {
            "C:\\Users\\me\\con\\IMG_0001.JPG"
        } else {
            "/home/user/con/IMG_0001.JPG"
        };
        assert!(validate_download_dest(dest).is_ok());
    }

    // ── 上書きの許可 ────────────────────────────────────────────────────

    #[test]
    fn refuses_to_overwrite_unless_told_to() {
        // 再帰検索で別フォルダの同名ファイルをまとめて取り出すと、宛先が
        // 重なって後勝ちで消えていた。衝突ダイアログはディスク上の既存しか
        // 見ないため、ここで止める。
        let dir = std::env::temp_dir().join(format!("shirube-mtp-ow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("IMG_0001.JPG");
        std::fs::write(&dest, b"first").unwrap();
        let dest_s = dest.to_str().unwrap();

        let e = preflight_download(dest_s, false).unwrap_err();
        assert!(e.contains("すでに存在"), "衝突を伝えていない: {e}");
        // 明示的に許可されたときだけ通す。
        assert!(preflight_download(dest_s, true).is_ok());

        // まだ無い宛先は許可なしでも通る。
        let fresh = dir.join("IMG_0002.JPG");
        assert!(preflight_download(fresh.to_str().unwrap(), false).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checks_the_name_even_when_overwrite_is_allowed() {
        // 上書き許可は「変な名前でも書いてよい」という意味ではない。
        let bad = if cfg!(windows) { "C:\\Users\\me\\NUL" } else { "/home/user/NUL" };
        assert!(preflight_download(bad, true).is_err());
    }

    // ── 子オブジェクトの選択 ────────────────────────────────────────────

    #[test]
    fn prefers_an_exact_name_match() {
        // 端末側は大小を区別する。完全一致があるならそれを選ぶ。
        let v = names(&["Photo.JPG", "photo.jpg"]);
        assert_eq!(pick_child_index(&v, "photo.jpg"), Ok(1));
        assert_eq!(pick_child_index(&v, "Photo.JPG"), Ok(0));
    }

    #[test]
    fn falls_back_to_case_insensitive_when_unambiguous() {
        let v = names(&["Photo.JPG", "video.mp4"]);
        assert_eq!(pick_child_index(&v, "photo.jpg"), Ok(0));
    }

    #[test]
    fn refuses_to_guess_between_case_variants() {
        // 取り違えて黙って別の中身を渡すより、取り出せないほうがまだ良い。
        let v = names(&["Photo.JPG", "PHOTO.jpg"]);
        assert!(pick_child_index(&v, "photo.JPG").is_err());
    }

    #[test]
    fn reports_a_missing_child() {
        assert!(pick_child_index(&names(&["a.txt"]), "b.txt").is_err());
    }

    // ── 端末の表示名の重複 ──────────────────────────────────────────────

    #[test]
    fn numbers_devices_that_share_a_friendly_name() {
        // 同じ機種を 2 台挿すと WPD のフレンドリ名がどちらも同じになる。
        // 仮想パスは表示名で端末を指すため、区別できないと 2 台目が開けない。
        let v = names(&["Apple iPhone", "Apple iPhone", "Pixel 9"]);
        assert_eq!(
            disambiguate_device_names(&v),
            vec![
                "Apple iPhone".to_string(),
                "Apple iPhone (2)".to_string(),
                "Pixel 9".to_string()
            ]
        );
    }

    #[test]
    fn leaves_unique_names_untouched() {
        let v = names(&["Apple iPhone", "Pixel 9"]);
        assert_eq!(disambiguate_device_names(&v), v);
    }

    #[test]
    fn resolves_each_duplicate_to_its_own_device() {
        // 以前はどちらを選んでも先に見つかったほうが開き、取り違えに
        // 気付けなかった。連番で 2 台目に届くこと。
        let v = names(&["Apple iPhone", "Apple iPhone"]);
        assert_eq!(pick_device_index(&v, "Apple iPhone"), Ok(0));
        assert_eq!(pick_device_index(&v, "Apple iPhone (2)"), Ok(1));
    }

    #[test]
    fn reports_an_unknown_device() {
        let v = names(&["Apple iPhone"]);
        assert!(pick_device_index(&v, "Pixel 9").is_err());
        // 3 台目は存在しない。
        assert!(pick_device_index(&v, "Apple iPhone (3)").is_err());
    }

    // ── パス分解 ────────────────────────────────────────────────────────

    #[test]
    fn parses_a_device_path() {
        let (dev, segs) = parse_mtp_path("mtp://Apple iPhone/Internal Storage/a.jpg").unwrap();
        assert_eq!(dev, "Apple iPhone");
        assert_eq!(segs, vec!["Internal Storage".to_string(), "a.jpg".to_string()]);
    }

    #[test]
    fn rejects_a_non_mtp_path() {
        assert!(parse_mtp_path("/home/user/a.jpg").is_none());
    }
}
