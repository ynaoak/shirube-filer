import type { SftpEntry } from "./types";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as { invoke: InvokeFn } | undefined;
  if (internals?.invoke) {
    return internals.invoke.bind(internals);
  }
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

type ConnArgs = {
  host: string;
  port: number;
  user: string;
  password: string;
};

export async function sftpListDir(
  conn: ConnArgs,
  remotePath: string
): Promise<SftpEntry[]> {
  return getInvoke()("sftp_list_dir", { ...conn, remotePath }) as Promise<SftpEntry[]>;
}

export async function sftpDownload(
  conn: ConnArgs,
  remotePath: string,
  localPath: string
): Promise<void> {
  await getInvoke()("sftp_download", { ...conn, remotePath, localPath });
}

export async function sftpUpload(
  conn: ConnArgs,
  localPath: string,
  remotePath: string
): Promise<void> {
  await getInvoke()("sftp_upload", { ...conn, localPath, remotePath });
}

// ── OS 資格情報ストア（キーリング）──────────────────────────────────────────
export async function secretSet(account: string, secret: string): Promise<void> {
  await getInvoke()("secret_set", { account, secret });
}
export async function secretGet(account: string): Promise<string | null> {
  return getInvoke()("secret_get", { account }) as Promise<string | null>;
}
export async function secretDelete(account: string): Promise<void> {
  await getInvoke()("secret_delete", { account });
}
