import type { DropboxEntry, DropboxTokens } from "./types";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as { invoke: InvokeFn } | undefined;
  if (internals?.invoke) return internals.invoke.bind(internals);
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

export async function dropboxStartOauthFlow(): Promise<DropboxTokens> {
  return getInvoke()("dropbox_start_oauth_flow") as Promise<DropboxTokens>;
}

export async function dropboxRefreshAccessToken(refreshToken: string): Promise<string> {
  return getInvoke()("dropbox_refresh_access_token", { refreshToken }) as Promise<string>;
}

export async function dropboxListFolder(
  accessToken: string,
  folderPath: string,
): Promise<DropboxEntry[]> {
  return getInvoke()("dropbox_list_folder", { accessToken, folderPath }) as Promise<DropboxEntry[]>;
}

export async function dropboxDownloadFile(
  accessToken: string,
  path: string,
  fileName: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("dropbox_download_file", { accessToken, path, fileName, localPath });
}

export async function dropboxUploadFile(
  accessToken: string,
  folderPath: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("dropbox_upload_file", { accessToken, folderPath, localPath });
}

export async function dropboxDeleteItem(
  accessToken: string,
  path: string,
): Promise<void> {
  await getInvoke()("dropbox_delete_item", { accessToken, path });
}

export async function dropboxCreateFolder(
  accessToken: string,
  parentPath: string,
  name: string,
): Promise<DropboxEntry> {
  return getInvoke()("dropbox_create_folder", { accessToken, parentPath, name }) as Promise<DropboxEntry>;
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
