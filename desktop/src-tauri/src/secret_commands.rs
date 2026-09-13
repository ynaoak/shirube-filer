//! OS ネイティブの資格情報ストアにシークレットを保存/取得するコマンド。
//!
//! - Windows: Credential Manager
//! - macOS:   Keychain
//! - Linux:   secret-service（GNOME Keyring / KWallet 等）
//!
//! service 名は固定、account は呼び出し側が `<jobId>:<field>` のような
//! 一意キーを渡す。値が空文字の場合は削除と同義に扱う（保存呼び出しを
//! delete にフォールバックさせるのは呼び出し側の責務）。

const SERVICE: &str = "shirube-filer-sync";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

// OS の資格情報ストア（Windows: Credential Manager / Linux: Secret Service）は
// ロック解除待ちなどで数秒ブロックすることがあるためバックグラウンド実行にする。
/// シークレットを保存する。
#[tauri::command(async)]
pub fn secret_set(account: String, secret: String) -> Result<(), String> {
    let e = entry(&account)?;
    e.set_password(&secret).map_err(|e| e.to_string())
}

/// シークレットを取得する。未登録なら None を返す（エラーにしない）。
#[tauri::command(async)]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    let e = entry(&account)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// シークレットを削除する。未登録でもエラーにしない（冪等）。
#[tauri::command(async)]
pub fn secret_delete(account: String) -> Result<(), String> {
    let e = entry(&account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
