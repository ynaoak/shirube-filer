import type { GDriveEntry, GDriveTokens } from "./types";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as { invoke: InvokeFn } | undefined;
  if (internals?.invoke) return internals.invoke.bind(internals);
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

export async function gdriveStartOauthFlow(): Promise<GDriveTokens> {
  return getInvoke()("gdrive_start_oauth_flow") as Promise<GDriveTokens>;
}

export async function gdriveRefreshAccessToken(refreshToken: string): Promise<string> {
  return getInvoke()("gdrive_refresh_access_token", { refreshToken }) as Promise<string>;
}

export async function gdriveListFiles(
  accessToken: string,
  folderId: string,
): Promise<GDriveEntry[]> {
  return getInvoke()("gdrive_list_files", { accessToken, folderId }) as Promise<GDriveEntry[]>;
}

export async function gdriveDownloadFile(
  accessToken: string,
  fileId: string,
  fileName: string,
  mimeType: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("gdrive_download_file", { accessToken, fileId, fileName, mimeType, localPath });
}

export async function gdriveUploadFile(
  accessToken: string,
  folderId: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("gdrive_upload_file", { accessToken, folderId, localPath });
}

export async function gdriveDeleteFile(
  accessToken: string,
  fileId: string,
): Promise<void> {
  await getInvoke()("gdrive_delete_file", { accessToken, fileId });
}

export async function gdriveCreateFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<GDriveEntry> {
  return getInvoke()("gdrive_create_folder", { accessToken, parentId, name }) as Promise<GDriveEntry>;
}

export async function dialogOpen(options?: { title?: string }): Promise<string | null> {
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
