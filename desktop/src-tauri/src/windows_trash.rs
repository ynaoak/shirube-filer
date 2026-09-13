//! Windows のゴミ箱移動を IFileOperation で直接行う実装。
//!
//! trash クレート（5.x）は `FOF_NO_UI` だけを立てて `PerformOperations` を呼び、
//! 失敗したかどうかを `GetAnyOperationsAborted` でしか見ていない。
//! `FOF_NO_UI` に含まれる `FOF_NOERRORUI` は `FOFX_EARLYFAILURE` と併用しない限り
//! 「エラーをユーザーが［無視］したものとして扱い、中断フラグだけ立てて処理を続ける」
//! という動作になる（SetOperationFlags のドキュメント参照）。
//! そのため、フォルダ削除でよくある「中のファイルが他プロセスに掴まれている
//! （共有違反）」「ゴミ箱の容量を超えている／ゴミ箱が無効なドライブ」「パスが
//! 長すぎてゴミ箱に入らない」といった原因がすべて
//! `Unknown { description: "Some operations were aborted" }` という原因不明の
//! エラーに潰れてしまい、ユーザーが対処できなかった。
//!
//! ここでは同じ IFileOperation を使いつつ、`FOFX_EARLYFAILURE`（エラーを握り
//! つぶさず HRESULT として返させる）と `IFileOperationProgressSink`（失敗した
//! アイテムと HRESULT を捕捉する）を足して、原因の分かるエラーに変換する。
//! ゴミ箱に入れられないケースは [`TrashError::Unavailable`] として区別し、
//! フロントエンドが「完全に削除しますか？」と確認できるようにしている
//! （勝手に完全削除はしない）。

use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use windows::core::{implement, Ref, HRESULT, PCWSTR};
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::{
    FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl,
    IShellItem, SHCreateItemFromParsingName, COPYENGINE_E_ACCESSDENIED_READONLY,
    COPYENGINE_E_ACCESS_DENIED_SRC, COPYENGINE_E_CANCELLED, COPYENGINE_E_PATH_NOT_FOUND_SRC,
    COPYENGINE_E_RECYCLE_BIN_NOT_FOUND, COPYENGINE_E_RECYCLE_FORCE_NUKE,
    COPYENGINE_E_RECYCLE_PATH_TOO_LONG, COPYENGINE_E_RECYCLE_SIZE_TOO_BIG,
    COPYENGINE_E_RECYCLE_UNKNOWN_ERROR, COPYENGINE_E_REQUIRES_ELEVATION,
    COPYENGINE_E_SHARING_VIOLATION_SRC, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_ALLOWUNDO,
    FOF_NO_UI, FOF_WANTNUKEWARNING, SIGDN_FILESYSPATH, SIGDN_NORMALDISPLAY,
};

/// 「ゴミ箱に入れられない」ことを表す目印。フロントエンドはこの文字列を見て
/// 完全削除に切り替えるかをユーザーに確認する。
pub const TRASH_UNAVAILABLE_MARKER: &str = "[TRASH_UNAVAILABLE]";

/// ゴミ箱へ移動できなかった理由。
#[derive(Debug)]
pub enum TrashError {
    /// ゴミ箱そのものが使えない（無効化・容量超過・パスが長すぎる等）。
    /// 完全削除なら成功する見込みがあるため、呼び出し側で確認できるよう区別する。
    Unavailable(String),
    /// それ以外の失敗（使用中・権限不足など）。
    Failed(String),
}

impl std::fmt::Display for TrashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrashError::Unavailable(reason) => {
                write!(
                    f,
                    "{TRASH_UNAVAILABLE_MARKER} ゴミ箱に移動できません: {reason}"
                )
            }
            TrashError::Failed(message) => write!(f, "ゴミ箱に移動できません: {message}"),
        }
    }
}

/// 1 件をゴミ箱へ移動する。
pub fn move_to_trash(path: &Path) -> Result<(), TrashError> {
    let target = shell_path(path);
    unsafe { delete_via_shell(&target) }
}

/// シェル API に渡せる形の絶対パスを作る。
///
/// * `fs::canonicalize` はスラッシュ区切りや `..` を正規化してくれるが、
///   `\\?\C:\...`（UNC は `\\?\UNC\server\share\...`）という拡張長パス表記を返す。
///   シェルはこの表記を解釈できないため元の表記へ戻す。
/// * 末尾要素そのものは解決しない（シンボリックリンクを削除するとき、リンク先では
///   なくリンク自体を消すため）。
fn shell_path(path: &Path) -> PathBuf {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return path.to_path_buf();
    };
    let Ok(canonical) = parent.canonicalize() else {
        return path.to_path_buf();
    };
    let Some(text) = canonical.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}")).join(name)
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest).join(name)
    } else {
        canonical.join(name)
    }
}

/// COM の初期化。IFileOperation は STA 推奨。すでに MTA で初期化済みのスレッドでは
/// `RPC_E_CHANGED_MODE` が返るが、その場合もそのまま利用できるため無視する。
/// （Tauri のワーカースレッドは使い回されるため、対になる `CoUninitialize` は
///   行わない。プロセス終了まで初期化されたままにする既存コマンドと同じ方針。）
unsafe fn ensure_com() {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
}

unsafe fn delete_via_shell(target: &Path) -> Result<(), TrashError> {
    ensure_com();

    let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
        .map_err(|e| TrashError::Failed(format!("シェルの操作を開始できません: {e}")))?;

    // FOF_NO_UI          … ダイアログを出さない（進捗・確認・エラーとも）
    // FOF_ALLOWUNDO      … 完全削除ではなくゴミ箱へ入れる
    // FOFX_RECYCLEONDELETE … 同上（Windows 8 以降の明示指定）
    // FOF_WANTNUKEWARNING … ゴミ箱に入らず完全削除になる場合は実行しない
    //                       （UI が無いため確認できず中断される。それを検出して
    //                         呼び出し側でユーザーに確認する）
    // FOFX_EARLYFAILURE  … エラーを無視して続行せず、HRESULT として返す
    op.SetOperationFlags(
        FOF_NO_UI | FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOF_WANTNUKEWARNING | FOFX_EARLYFAILURE,
    )
    .map_err(|e| TrashError::Failed(format!("シェルの操作を設定できません: {e}")))?;

    let wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
        .map_err(|e| classify(e.code(), &target.display().to_string()))?;

    let failure = Arc::new(Mutex::new(None::<(String, HRESULT)>));
    let sink: IFileOperationProgressSink = DeleteSink {
        failure: failure.clone(),
    }
    .into();

    op.DeleteItem(&item, &sink)
        .map_err(|e| classify(e.code(), &target.display().to_string()))?;

    let performed = op.PerformOperations();
    let aborted = op
        .GetAnyOperationsAborted()
        .map(|b| b.as_bool())
        .unwrap_or(false);
    let failed_item = failure.lock().ok().and_then(|mut f| f.take());

    match performed {
        Err(e) => {
            // シンクが掴んだ個別の HRESULT の方が具体的なのでそちらを優先する。
            let (name, hr) =
                failed_item.unwrap_or_else(|| (target.display().to_string(), e.code()));
            Err(classify(hr, &name))
        }
        Ok(()) => {
            if let Some((name, hr)) = failed_item {
                return Err(classify(hr, &name));
            }
            if aborted && std::fs::symlink_metadata(target).is_ok() {
                // 中断されたのに対象が残っている＝ゴミ箱へ入れられなかった。
                // FOF_WANTNUKEWARNING による確認が UI 無しで中断された場合がこれにあたる。
                return Err(TrashError::Unavailable(
                    "ゴミ箱が無効か、容量を超えている可能性があります".to_string(),
                ));
            }
            Ok(())
        }
    }
}

/// HRESULT を利用者に意味の伝わるメッセージへ変換する。
/// 定数はパターンで書けない（HRESULT は構造体）ため if 連鎖で比較する。
fn classify(hr: HRESULT, name: &str) -> TrashError {
    let win32 = |code: windows::Win32::Foundation::WIN32_ERROR| HRESULT::from_win32(code.0);

    if hr == COPYENGINE_E_RECYCLE_BIN_NOT_FOUND {
        TrashError::Unavailable("このドライブにはゴミ箱がありません".to_string())
    } else if hr == COPYENGINE_E_RECYCLE_SIZE_TOO_BIG {
        TrashError::Unavailable("ゴミ箱の容量を超えています".to_string())
    } else if hr == COPYENGINE_E_RECYCLE_PATH_TOO_LONG {
        TrashError::Unavailable("パスが長すぎてゴミ箱に入れられません".to_string())
    } else if hr == COPYENGINE_E_RECYCLE_FORCE_NUKE || hr == COPYENGINE_E_RECYCLE_UNKNOWN_ERROR {
        TrashError::Unavailable("この項目はゴミ箱に入れられません".to_string())
    } else if hr == COPYENGINE_E_SHARING_VIOLATION_SRC || hr == win32(ERROR_SHARING_VIOLATION) {
        TrashError::Failed(format!(
            "{name} を他のプログラムが使用中です。開いているアプリを閉じてから再試行してください"
        ))
    } else if hr == COPYENGINE_E_ACCESS_DENIED_SRC
        || hr == COPYENGINE_E_ACCESSDENIED_READONLY
        || hr == COPYENGINE_E_REQUIRES_ELEVATION
        || hr == win32(ERROR_ACCESS_DENIED)
    {
        TrashError::Failed(format!(
            "{name} へのアクセスが拒否されました。読み取り専用属性や権限を確認してください"
        ))
    } else if hr == COPYENGINE_E_PATH_NOT_FOUND_SRC
        || hr == win32(ERROR_FILE_NOT_FOUND)
        || hr == win32(ERROR_PATH_NOT_FOUND)
    {
        TrashError::Failed(format!("{name} が見つかりません"))
    } else if hr == COPYENGINE_E_CANCELLED {
        TrashError::Failed(format!("{name} の削除が中断されました"))
    } else {
        TrashError::Failed(format!("{name} (0x{:08X})", hr.0 as u32))
    }
}

/// 失敗したアイテムと HRESULT を 1 件だけ記録する進捗シンク。
/// （`delete_item` は 1 パスずつ呼ばれるが、フォルダの場合は配下の各項目について
///   通知が来るため、最初に失敗したものが原因として最も有用。）
#[implement(IFileOperationProgressSink)]
struct DeleteSink {
    failure: Arc<Mutex<Option<(String, HRESULT)>>>,
}

impl DeleteSink_Impl {
    fn record(&self, item: Ref<'_, IShellItem>, hr: HRESULT) {
        if hr.is_ok() {
            return;
        }
        let name = item
            .as_ref()
            .and_then(|i| unsafe { display_name(i) })
            .unwrap_or_default();
        if let Ok(mut slot) = self.failure.lock() {
            if slot.is_none() {
                *slot = Some((name, hr));
            }
        }
    }
}

/// 失敗したアイテムの表示名。フォルダ配下のどのファイルで失敗したかを伝えたいので
/// フルパス（`SIGDN_FILESYSPATH`）を優先し、取れなければ表示名で代用する。
unsafe fn display_name(item: &IShellItem) -> Option<String> {
    for kind in [SIGDN_FILESYSPATH, SIGDN_NORMALDISPLAY] {
        let Ok(raw) = item.GetDisplayName(kind) else {
            continue;
        };
        let text = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        if text.is_some() {
            return text;
        }
    }
    None
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for DeleteSink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _hrresult: HRESULT) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(
        &self,
        _dwflags: u32,
        _psiitem: Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _dwflags: u32,
        _psiitem: Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _hrrename: HRESULT,
        _psinewlycreated: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _dwflags: u32,
        _psiitem: Ref<'_, IShellItem>,
        _psidestinationfolder: Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _dwflags: u32,
        _psiitem: Ref<'_, IShellItem>,
        _psidestinationfolder: Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _hrmove: HRESULT,
        _psinewlycreated: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _dwflags: u32,
        _psiitem: Ref<'_, IShellItem>,
        _psidestinationfolder: Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _dwflags: u32,
        _psiitem: Ref<'_, IShellItem>,
        _psidestinationfolder: Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _hrcopy: HRESULT,
        _psinewlycreated: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreDeleteItem(
        &self,
        _dwflags: u32,
        _psiitem: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostDeleteItem(
        &self,
        _dwflags: u32,
        psiitem: Ref<'_, IShellItem>,
        hrdelete: HRESULT,
        _psinewlycreated: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        self.record(psiitem, hrdelete);
        Ok(())
    }
    fn PreNewItem(
        &self,
        _dwflags: u32,
        _psidestinationfolder: Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _dwflags: u32,
        _psidestinationfolder: Ref<'_, IShellItem>,
        _psznewname: &PCWSTR,
        _psztemplatename: &PCWSTR,
        _dwfileattributes: u32,
        _hrnew: HRESULT,
        _psinewitem: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _iworktotal: u32, _iworksofar: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_path_strips_verbatim_prefix() {
        let dir = std::env::temp_dir().join("shirube_shell_path_test");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("item.txt");

        let resolved = shell_path(&target);
        let text = resolved.to_str().unwrap();
        assert!(!text.starts_with(r"\\?\"), "verbatim prefix left in {text}");
        assert!(text.ends_with(r"\item.txt"), "unexpected path {text}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shell_path_normalizes_forward_slashes() {
        let dir = std::env::temp_dir().join("shirube_shell_path_slash");
        std::fs::create_dir_all(&dir).unwrap();
        let mixed = PathBuf::from(format!(
            "{}/item.txt",
            dir.to_str().unwrap().replace('\\', "/")
        ));

        let resolved = shell_path(&mixed);
        assert!(
            !resolved.to_str().unwrap().contains('/'),
            "forward slash left in {}",
            resolved.display()
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shell_path_keeps_unknown_paths_as_is() {
        // 存在しない親（canonicalize 失敗）はそのまま返し、シェルに判断させる。
        let path = PathBuf::from(r"C:\shirube-does-not-exist-9f3a\item.txt");
        assert_eq!(shell_path(&path), path);
    }
}
