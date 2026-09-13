import type { BoxEntry, BoxTokens } from "./types";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as { invoke: InvokeFn } | undefined;
  if (internals?.invoke) return internals.invoke.bind(internals);
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

export async function boxStartOauthFlow(): Promise<BoxTokens> {
  return getInvoke()("box_start_oauth_flow") as Promise<BoxTokens>;
}

// 進行中の OAuth 待機を中断する。待機中の boxStartOauthFlow は即座に reject される。
export async function boxCancelOauthFlow(): Promise<void> {
  await getInvoke()("cancel_oauth_flow", { service: "box" });
}

export async function boxRefreshAccessToken(refreshToken: string): Promise<BoxTokens> {
  return getInvoke()("box_refresh_access_token", { refreshToken }) as Promise<BoxTokens>;
}

export async function boxListFolder(
  accessToken: string,
  folderId: string,
): Promise<BoxEntry[]> {
  return getInvoke()("box_list_folder", { accessToken, folderId }) as Promise<BoxEntry[]>;
}

export async function boxDownloadFile(
  accessToken: string,
  fileId: string,
  fileName: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("box_download_file", { accessToken, fileId, fileName, localPath });
}

export async function boxUploadFile(
  accessToken: string,
  folderId: string,
  localPath: string,
): Promise<void> {
  await getInvoke()("box_upload_file", { accessToken, folderId, localPath });
}

export async function boxDeleteItem(
  accessToken: string,
  itemId: string,
  isDir: boolean,
): Promise<void> {
  await getInvoke()("box_delete_item", { accessToken, itemId, isDir });
}

export async function boxCreateFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<BoxEntry> {
  return getInvoke()("box_create_folder", { accessToken, parentId, name }) as Promise<BoxEntry>;
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
