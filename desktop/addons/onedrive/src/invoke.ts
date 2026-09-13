import type { OneDriveEntry, OneDriveTokens } from "./types";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as { invoke: InvokeFn } | undefined;
  if (internals?.invoke) return internals.invoke.bind(internals);
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

export async function onedriveStartOauthFlow(): Promise<OneDriveTokens> {
  return getInvoke()("onedrive_start_oauth_flow") as Promise<OneDriveTokens>;
}

export async function onedriveRefreshAccessToken(refreshToken: string): Promise<string> {
  return getInvoke()("onedrive_refresh_access_token", { refreshToken }) as Promise<string>;
}

export async function onedriveListFiles(
  accessToken: string,
  folderId: string,
): Promise<OneDriveEntry[]> {
  return getInvoke()("onedrive_list_files", { accessToken, folderId }) as Promise<OneDriveEntry[]>;
}

export async function onedriveDownloadFile(
  accessToken: string,
  fileId: string,
  fileName: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("onedrive_download_file", { accessToken, fileId, fileName, localPath });
}

export async function onedriveUploadFile(
  accessToken: string,
  folderId: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("onedrive_upload_file", { accessToken, folderId, localPath });
}

export async function onedriveDeleteFile(
  accessToken: string,
  fileId: string,
): Promise<void> {
  await getInvoke()("onedrive_delete_file", { accessToken, fileId });
}

export async function onedriveCreateFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<OneDriveEntry> {
  return getInvoke()("onedrive_create_folder", { accessToken, parentId, name }) as Promise<OneDriveEntry>;
}

export async function dialogOpen(options?: { title?: string }): Promise<string | null> {
  const result = await getInvoke()("plugin:dialog|open", {
    multiple: false, directory: false,
    title: options?.title ?? null, defaultPath: null, filters: null,
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
