import type { WebDavEntry } from "./types";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as { invoke: InvokeFn } | undefined;
  if (internals?.invoke) {
    return internals.invoke.bind(internals);
  }
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

export async function webdavListDir(
  url: string,
  username: string,
  password: string
): Promise<WebDavEntry[]> {
  return getInvoke()("webdav_list_dir", { url, username, password }) as Promise<WebDavEntry[]>;
}

export async function webdavDownload(
  url: string,
  username: string,
  password: string,
  localDir: string,
  filename: string
): Promise<void> {
  await getInvoke()("webdav_download", { url, username, password, localDir, filename });
}

export async function webdavUpload(
  url: string,
  username: string,
  password: string,
  localPath: string
): Promise<void> {
  await getInvoke()("webdav_upload", { url, username, password, localPath });
}

export async function webdavDelete(
  url: string,
  username: string,
  password: string
): Promise<void> {
  await getInvoke()("webdav_delete", { url, username, password });
}

export async function webdavMkdir(
  url: string,
  username: string,
  password: string
): Promise<void> {
  await getInvoke()("webdav_mkdir", { url, username, password });
}
