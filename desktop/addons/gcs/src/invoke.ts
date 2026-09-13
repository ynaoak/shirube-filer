import type { GcsBucket, GcsEntry, GcsTokens } from "./types";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as { invoke: InvokeFn } | undefined;
  if (internals?.invoke) return internals.invoke.bind(internals);
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

/** OAuth 2.0 PKCE フローを開始してトークンを取得する。ブラウザが開き、認証後に返る。 */
export async function gcsStartOauthFlow(): Promise<GcsTokens> {
  return getInvoke()("gcs_start_oauth_flow") as Promise<GcsTokens>;
}

/** refresh_token を使って新しい access_token を取得する。 */
export async function gcsRefreshAccessToken(
  refreshToken: string,
): Promise<string> {
  return getInvoke()("gcs_refresh_access_token", {
    refreshToken,
  }) as Promise<string>;
}

export async function gcsListBuckets(
  accessToken: string,
  projectId: string,
): Promise<GcsBucket[]> {
  return getInvoke()("gcs_list_buckets", { accessToken, projectId }) as Promise<GcsBucket[]>;
}

export async function gcsListObjects(
  accessToken: string,
  bucket: string,
  prefix: string,
): Promise<GcsEntry[]> {
  return getInvoke()("gcs_list_objects", { accessToken, bucket, prefix }) as Promise<GcsEntry[]>;
}

export async function gcsDownloadObject(
  accessToken: string,
  bucket: string,
  key: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("gcs_download_object", { accessToken, bucket, key, localPath });
}

export async function gcsUploadObject(
  accessToken: string,
  bucket: string,
  prefix: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("gcs_upload_object", { accessToken, bucket, prefix, localPath });
}

export async function gcsDeleteObject(
  accessToken: string,
  bucket: string,
  key: string,
): Promise<void> {
  await getInvoke()("gcs_delete_object", { accessToken, bucket, key });
}

export async function dialogOpen(options?: {
  title?: string;
}): Promise<string | null> {
  const result = await getInvoke()("plugin:dialog|open", {
    multiple: false,
    directory: false,
    title: options?.title ?? null,
    defaultPath: null,
    filters: null,
  });
  return result as string | null;
}

// ── OS 資格情報ストア（キーリング）──────────────────────────────────────────
// リフレッシュトークン等のシークレットは localStorage ではなく OS のセキュアストア
// （Windows 資格情報マネージャー / macOS キーチェーン / Linux Secret Service）に保存する。
export async function secretSet(account: string, secret: string): Promise<void> {
  await getInvoke()("secret_set", { account, secret });
}

export async function secretGet(account: string): Promise<string | null> {
  return getInvoke()("secret_get", { account }) as Promise<string | null>;
}

export async function secretDelete(account: string): Promise<void> {
  await getInvoke()("secret_delete", { account });
}
