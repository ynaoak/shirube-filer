use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

/// 進行中の長時間処理のキャンセルフラグを操作ごとに管理する。
///
/// 旧実装は `Option<Arc<AtomicBool>>` 1 つだけだったため、複数操作（コピーと
/// S3 ダウンロードを並行で走らせる等）の begin() が互いを上書きし、
/// cancel_operation が誤った操作をキャンセルする / 早く終わった操作の
/// end() で他のフラグが消える、というバグがあった。
///
/// 各操作は begin() でユニークな id と Arc<AtomicBool> を受け取り、
/// 処理終了時に end(id) で自身のスロットだけを解放する。
/// cancel_operation は「現在登録されている全フラグを true」にする。
/// （UI 側で個別操作のキャンセルが必要になれば cancel_one(id) を足す。）
pub struct CancelState {
    map: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    next_id: AtomicU64,
}

impl Default for CancelState {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

/// 関数の途中 return（`?` でのエラー伝搬を含む）でも確実に end() が呼ばれるよう、
/// CancelState を Drop で自動解放する RAII ガード。
///
/// `Deref<Target=Arc<AtomicBool>>` を実装しているため、既存コードの
/// `let flag = cancel.begin();` `flag.load(Ordering::Relaxed)` がそのまま動く。
/// ガード自体が drop されたタイミングで CancelState の HashMap から自身のスロットが
/// 自動的に取り除かれるので、明示的な end() 呼び出しは不要。
pub struct CancelGuard<'a> {
    state: &'a CancelState,
    id: u64,
    flag: Arc<AtomicBool>,
}

impl<'a> CancelGuard<'a> {
    /// `Arc<AtomicBool>` の clone を返す（スレッド間で flag を共有したい場合に使う）。
    #[allow(dead_code)]
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

impl<'a> std::ops::Deref for CancelGuard<'a> {
    type Target = Arc<AtomicBool>;
    fn deref(&self) -> &Self::Target {
        &self.flag
    }
}

impl<'a> Drop for CancelGuard<'a> {
    fn drop(&mut self) {
        // poison しても処理を継続する（パニックで以降の操作が一切キャンセル不能に
        // なるのを防ぐ）。
        let mut map = match self.state.map.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        map.remove(&self.id);
    }
}

impl CancelState {
    /// 新しいキャンセルフラグを発行し、HashMap に登録した上でガードを返す。
    /// ガードが drop されるとフラグが自動的に解放される。
    pub fn begin(&self) -> CancelGuard<'_> {
        let flag = Arc::new(AtomicBool::new(false));
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut map = match self.map.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        map.insert(id, flag.clone());
        CancelGuard {
            state: self,
            id,
            flag,
        }
    }

    /// 後方互換のための no-op。旧 API は `let flag = cancel.begin();` 形式で
    /// 明示的に `cancel.end()` を呼んでいたが、新 API では CancelGuard が drop
    /// 時に自動解放するので何もしない。
    ///
    /// CancelGuard.deref() を通じて `cancel.end()` のような呼び出しが残っていても
    /// コンパイルさせるためのスタブ。リファクタ完了後に削除予定。
    #[allow(dead_code)]
    pub fn end(&self) {
        // 旧 API との互換のため何もしない。実際の解放は CancelGuard::drop で行う。
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub current: usize,
    pub total: usize,
    pub file: String,
    pub done: bool,
    /// Bytes transferred so far (0 if not tracked)
    pub bytes_done: u64,
    /// Total bytes to transfer (0 if not known yet)
    pub bytes_total: u64,
}

#[tauri::command]
pub fn cancel_operation(cancel: tauri::State<'_, CancelState>) {
    // 現在登録されている全フラグを true にする。
    // （操作ごとの個別キャンセルが必要になったら id を引数に取るバリアントを追加する。）
    let map = match cancel.map.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    for flag in map.values() {
        flag.store(true, Ordering::Relaxed);
    }
}
