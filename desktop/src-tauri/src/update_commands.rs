use serde::{Deserialize, Serialize};

/// フロントへ返す更新チェック結果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 現在実行中のアプリのバージョン。
    pub current: String,
    /// 公開されている最新バージョン。
    pub latest: String,
    /// 最新の方が新しいか。
    pub update_available: bool,
    /// 入手ページ（ダウンロード先）の URL。
    pub url: String,
    /// 任意のリリースノート（空可）。
    pub notes: String,
}

/// 公開サイトに置く更新マニフェストの形。
#[derive(Debug, Deserialize)]
struct VersionManifest {
    version: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    notes: String,
}

/// 更新マニフェストの URL（公開サイト上）。リポジトリの公開/非公開に依存しないよう、
/// GitHub API ではなく自前の公開サイトを参照する。
const VERSION_URL: &str = "https://shirube-filer.ynaoak.dev/version.json";
/// マニフェストに url が無い場合のフォールバック入手ページ。
const DOWNLOAD_URL: &str = "https://shirube-filer.ynaoak.dev/#pricing";

/// `0.1.12` / `v0.1.13` のようなバージョン文字列をドット/ハイフン区切りの数値列にして比較する。
fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(s: &str) -> Vec<u64> {
        s.trim().trim_start_matches('v')
            .split(['.', '-'])
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    }
    parts(a).cmp(&parts(b))
}

/// 最新バージョンを公開マニフェストから取得し、現在のバージョンと比較する。
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();

    let resp = crate::http_client::client()
        .get(VERSION_URL)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("更新情報の取得に失敗しました: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("更新情報の取得に失敗しました ({})", resp.status()));
    }

    let manifest: VersionManifest = resp
        .json()
        .await
        .map_err(|e| format!("更新情報の解析に失敗しました: {}", e))?;

    let update_available = cmp_version(&manifest.version, &current) == std::cmp::Ordering::Greater;
    let url = if manifest.url.trim().is_empty() {
        DOWNLOAD_URL.to_string()
    } else {
        manifest.url
    };

    Ok(UpdateInfo {
        current,
        latest: manifest.version,
        update_available,
        url,
        notes: manifest.notes,
    })
}
