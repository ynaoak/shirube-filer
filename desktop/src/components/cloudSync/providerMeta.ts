import { OAUTH_PROVIDERS, type SyncProvider } from "../../store/syncStore";

// ── プロバイダ共通のメタ情報（ラベル・OAuth 判定など） ──────────────────
// CloudSyncPanel / ConnectionSettingsDialog の双方から参照するため
// 単一の場所にまとめる。

/** OAuth 2.0（PKCE）でリフレッシュトークンを用いるプロバイダかどうか。 */
export const isOauth = (p: SyncProvider) => OAUTH_PROVIDERS.includes(p);

/** 接続方式のラベル用 i18n キー（OAuth / アクセスキー / SAS / パスワード）を返す。 */
export function methodLabelKey(p: SyncProvider): string {
  if (isOauth(p)) return "cloudSync.methodOauth";
  if (p === "s3") return "cloudSync.methodAccessKey";
  if (p === "azblob") return "cloudSync.methodSas";
  return "cloudSync.methodPassword"; // sftp / webdav
}

/** プロバイダの表示名。 */
export function providerLabel(p: SyncProvider) {
  switch (p) {
    case "s3": return "S3";
    case "azblob": return "Azure Blob";
    case "sftp": return "SFTP";
    case "webdav": return "WebDAV";
    case "box": return "Box";
    case "dropbox": return "Dropbox";
    case "gcs": return "Google Cloud Storage";
    case "gdrive": return "Google Drive";
    case "onedrive": return "OneDrive";
  }
}
