import type { S3Bucket, S3Entry, S3Profile } from "./types";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as { invoke: InvokeFn } | undefined;
  if (internals?.invoke) {
    return internals.invoke.bind(internals);
  }
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

type ConnArgs = Pick<S3Profile, "accessKey" | "secretKey" | "region"> & { endpoint?: string };

function profileToArgs(p: ConnArgs) {
  return {
    accessKey: p.accessKey,
    secretKey: p.secretKey,
    region: p.region,
    endpoint: p.endpoint || null,
  };
}

export async function s3ListBuckets(profile: ConnArgs): Promise<S3Bucket[]> {
  return getInvoke()("s3_list_buckets", profileToArgs(profile)) as Promise<S3Bucket[]>;
}

export async function s3ListObjects(
  profile: ConnArgs,
  bucket: string,
  prefix: string
): Promise<S3Entry[]> {
  return getInvoke()("s3_list_objects", {
    ...profileToArgs(profile),
    bucket,
    prefix,
  }) as Promise<S3Entry[]>;
}

export async function s3DownloadObject(
  profile: ConnArgs,
  bucket: string,
  key: string,
  localPath: string
): Promise<void> {
  await getInvoke()("s3_download_object", {
    ...profileToArgs(profile),
    bucket,
    key,
    localPath,
  });
}

export async function s3UploadObject(
  profile: ConnArgs,
  bucket: string,
  key: string,
  localPath: string
): Promise<void> {
  await getInvoke()("s3_upload_object", {
    ...profileToArgs(profile),
    bucket,
    key,
    localPath,
  });
}

export async function s3DeleteObject(
  profile: ConnArgs,
  bucket: string,
  key: string
): Promise<void> {
  await getInvoke()("s3_delete_object", {
    ...profileToArgs(profile),
    bucket,
    key,
  });
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

export async function dialogOpen(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | null> {
  const result = await getInvoke()("plugin:dialog|open", {
    multiple: false,
    directory: false,
    title: options?.title ?? null,
    defaultPath: options?.defaultPath ?? null,
    filters: options?.filters ?? null,
  });
  return result as string | null;
}
