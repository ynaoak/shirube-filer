//! クラウド API 用の共有 reqwest クライアント。
//!
//! タイムアウト無しの `Client::new()` はネットワーク異常（切断・黒穴化した接続）で
//! リクエストが永遠に完了せず、フロントの invoke が pending のまま UI がローディング
//! 表示で固まる原因になる。クラウド系コマンドは必ずこのクライアントを使うこと。
//! - 接続確立: 15 秒
//! - リクエスト全体: 15 分（大きいファイルのアップロード / ダウンロードを考慮）

use std::sync::OnceLock;
use std::time::Duration;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 共有クライアントを返す（reqwest::Client は内部 Arc なので clone は安価）。
pub fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .build()
                // ビルダーは TLS 初期化失敗時のみ Err を返す。起動直後に一度だけ
                // 呼ばれる箇所であり、失敗時はクラウド機能全体が使えないため panic で良い。
                .expect("failed to build shared reqwest client")
        })
        .clone()
}
