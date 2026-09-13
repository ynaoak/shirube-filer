/**
 * クラウド同期エンジン。
 * - ダウンロード同期: リモート優先（リモートが新しいファイルをローカルへ）
 * - アップロード同期: ローカル優先（ローカルが新しいファイルをリモートへ）
 * - 削除の同期は行わない（データ消失リスクを避けるため MVP では対象外）
 * - 全ての Tauri invoke はここで一元的に呼び出す
 */
import { invoke } from "@tauri-apps/api/core";
import { APP_EVENTS } from "./appEvents";
import { recordSyncHistory, type SyncHistoryDirection } from "./syncHistory";
import type {
  CloudSyncJob,
  SyncProvider,
  S3SyncCreds,
  AzblobSyncCreds,
  SftpSyncCreds,
  WebdavSyncCreds,
  BoxSyncCreds,
  DropboxSyncCreds,
  GcsSyncCreds,
  GdriveSyncCreds,
  OnedriveSyncCreds,
} from "../store/syncStore";

// ── 共通型 ──────────────────────────────────────────────────────────
export type RemoteEntry = {
  name: string;
  /** フルリモートキー / パス（ダウンロード時に使う） */
  remoteKey: string;
  /** 同期ルートからの相対パス（POSIX 区切り）。再帰時はサブパスを含む。 */
  relPath: string;
  size: number;
  lastModified: number | null; // Unix 秒
  isDir: boolean;
  /** Google Drive 用。ダウンロード時の export 判定に使う MIME タイプ。 */
  mimeType?: string;
};

export type LocalEntry = {
  name: string;
  path: string;
  /** 同期ルートからの相対パス（POSIX 区切り）。 */
  relPath: string;
  size: number;
  modified: number | null;
};

export type SyncDiffItem = {
  /** 同期ルートからの相対パス（diff のキー）。 */
  name: string;
  /** "download" = リモートが新しい / "upload" = ローカルが新しい / "same" = 変更なし */
  direction: "download" | "upload" | "same";
  remote: RemoteEntry | null;
  local: LocalEntry | null;
};

export type SyncResult = {
  ok: number;
  failed: number;
  errors: string[];
};

/** 再帰の暴走を防ぐための最大階層深さ。 */
const MAX_RECURSION_DEPTH = 32;

/** relPath を結合（先頭の rel が空なら name のみ）。 */
function joinRel(rel: string, name: string): string {
  return rel ? `${rel}/${name}` : name;
}

/** relPath の親ディレクトリ部分（POSIX）。直下なら ""。 */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i >= 0 ? relPath.slice(0, i) : "";
}

/** ISO8601 文字列を Unix 秒へ変換（不正/空なら null）。 */
function isoToUnix(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// ── OAuth トークン管理 ────────────────────────────────────────────────
// box/dropbox/gcs/gdrive/onedrive は OAuth 2.0。永続化するのは refreshToken のみで、
// アクセストークンは refreshToken から都度発行し、ジョブ単位でキャッシュする。
// Box は refresh のたびに refreshToken がローテーションするため、新しい値を
// キーチェーン（updateJob 経由）へ反映する。

type TokenCacheEntry = { accessToken: string; ts: number; refreshToken: string };
const tokenCache = new Map<string, TokenCacheEntry>();
const ACCESS_TOKEN_TTL_MS = 45 * 60 * 1000;

/** ローテーションした refreshToken を React 状態へ反映するためのコールバック。 */
let credsUpdater: ((id: string, patch: Partial<CloudSyncJob>) => void) | null = null;
export function setCredsUpdater(
  fn: ((id: string, patch: Partial<CloudSyncJob>) => void) | null,
): void {
  credsUpdater = fn;
}

/** 再接続時などにアクセストークンキャッシュを破棄する。 */
export function clearTokenCache(jobId: string): void {
  tokenCache.delete(jobId);
}

const OAUTH_START_CMD: Partial<Record<SyncProvider, string>> = {
  box: "box_start_oauth_flow",
  dropbox: "dropbox_start_oauth_flow",
  gcs: "gcs_start_oauth_flow",
  gdrive: "gdrive_start_oauth_flow",
  onedrive: "onedrive_start_oauth_flow",
};

/**
 * OAuth 2.0（PKCE）認証フローを開始し、得られた refreshToken を返す（＝接続）。
 * ブラウザが開き、ユーザー認証後にカスタム URI スキーム経由で完了する。
 */
export async function startOauthConnect(provider: SyncProvider): Promise<string> {
  const cmd = OAUTH_START_CMD[provider];
  if (!cmd) throw new Error("このプロバイダは OAuth 認証に対応していません。");
  const tokens = await invoke<{ accessToken: string; refreshToken: string | null }>(cmd);
  if (!tokens.refreshToken) {
    throw new Error("リフレッシュトークンを取得できませんでした（再認証が必要です）。");
  }
  return tokens.refreshToken;
}

/**
 * 進行中の OAuth 認証待機を中断する（＝再接続できるようにする）。
 * 待機中の startOauthConnect は即座に reject される。
 * provider は Rust 側の SERVICE_KEY（deep-link の oauth/<service>）と一致している。
 */
export async function cancelOauthConnect(provider: SyncProvider): Promise<void> {
  await invoke("cancel_oauth_flow", { service: provider });
}

/** OAuth プロバイダなら認証情報（refreshToken を持つ）を返す。 */
function oauthCreds(job: CloudSyncJob): { refreshToken: string } | null {
  switch (job.provider) {
    case "box": return job.box ?? null;
    case "dropbox": return job.dropbox ?? null;
    case "gcs": return job.gcs ?? null;
    case "gdrive": return job.gdrive ?? null;
    case "onedrive": return job.onedrive ?? null;
    default: return null;
  }
}

async function refreshAccessToken(
  provider: SyncProvider,
  refreshToken: string,
): Promise<{ accessToken: string; rotatedRefresh?: string }> {
  switch (provider) {
    case "box": {
      const t = await invoke<{ accessToken: string; refreshToken: string | null }>(
        "box_refresh_access_token", { refreshToken },
      );
      return { accessToken: t.accessToken, rotatedRefresh: t.refreshToken ?? undefined };
    }
    case "dropbox":
      return { accessToken: await invoke<string>("dropbox_refresh_access_token", { refreshToken }) };
    case "gcs":
      return { accessToken: await invoke<string>("gcs_refresh_access_token", { refreshToken }) };
    case "gdrive":
      return { accessToken: await invoke<string>("gdrive_refresh_access_token", { refreshToken }) };
    case "onedrive":
      return { accessToken: await invoke<string>("onedrive_refresh_access_token", { refreshToken }) };
    default:
      return { accessToken: "" };
  }
}

/** ローテーションした refreshToken を反映する creds パッチを作る。 */
function refreshPatch(job: CloudSyncJob, refreshToken: string): Partial<CloudSyncJob> {
  switch (job.provider) {
    case "box": return { box: { ...job.box!, refreshToken } };
    case "dropbox": return { dropbox: { ...job.dropbox!, refreshToken } };
    case "gcs": return { gcs: { ...job.gcs!, refreshToken } };
    case "gdrive": return { gdrive: { ...job.gdrive!, refreshToken } };
    case "onedrive": return { onedrive: { ...job.onedrive!, refreshToken } };
    default: return {};
  }
}

/**
 * ジョブの有効なアクセストークンを返す（非 OAuth プロバイダは ""）。
 * キャッシュが新鮮ならそれを返し、無ければ refreshToken から発行する。
 */
async function getAccessToken(job: CloudSyncJob): Promise<string> {
  const creds = oauthCreds(job);
  if (!creds) return ""; // s3 / sftp / webdav
  if (!creds.refreshToken) {
    throw new Error("クラウドに未接続です。ジョブの「接続」ボタンから認証してください。");
  }
  const cached = tokenCache.get(job.id);
  const now = Date.now();
  if (cached && now - cached.ts < ACCESS_TOKEN_TTL_MS) {
    return cached.accessToken;
  }
  // ローテーション済みの最新トークンを優先（古いジョブ参照でも破綻しないように）。
  const useRefresh = cached?.refreshToken || creds.refreshToken;
  const { accessToken, rotatedRefresh } = await refreshAccessToken(job.provider, useRefresh);
  const effective = rotatedRefresh || useRefresh;
  tokenCache.set(job.id, { accessToken, ts: now, refreshToken: effective });
  if (rotatedRefresh && rotatedRefresh !== creds.refreshToken) {
    credsUpdater?.(job.id, refreshPatch(job, rotatedRefresh));
  }
  return accessToken;
}

// ── プロバイダ別: リモートエントリ一覧（1階層） ─────────────────────
// 戻り値にはファイルとディレクトリの両方を含める（再帰ラッパが dir を辿る）。

async function listOneS3(c: S3SyncCreds, prefix: string): Promise<RemoteEntry[]> {
  type S3Entry = { key: string; name: string; isPrefix: boolean; size: number; lastModified: number | null };
  const entries = await invoke<S3Entry[]>("s3_list_objects", {
    accessKey: c.accessKey,
    secretKey: c.secretKey,
    region: c.region,
    endpoint: c.endpoint || null,
    bucket: c.bucket,
    prefix,
  });
  return entries.map((e) => ({
    name: e.name,
    remoteKey: e.key,
    relPath: "", // 再帰ラッパで設定
    size: e.size,
    lastModified: e.lastModified,
    isDir: e.isPrefix,
  }));
}

async function listOneAzblob(c: AzblobSyncCreds, prefix: string): Promise<RemoteEntry[]> {
  type AzEntry = { key: string; name: string; isPrefix: boolean; size: number; lastModified: number | null };
  const entries = await invoke<AzEntry[]>("azblob_list_objects", {
    account: c.account,
    container: c.container,
    sasToken: c.sasToken,
    endpoint: c.endpoint || null,
    prefix,
  });
  return entries.map((e) => ({
    name: e.name,
    remoteKey: e.key,
    relPath: "",
    size: e.size,
    lastModified: e.lastModified,
    isDir: e.isPrefix,
  }));
}

async function listOneSftp(c: SftpSyncCreds, remotePath: string): Promise<RemoteEntry[]> {
  type SftpEntry = { name: string; path: string; isDir: boolean; size: number; modified: number | null };
  const entries = await invoke<SftpEntry[]>("sftp_list_dir", {
    host: c.host, port: c.port, user: c.username, password: c.password, remotePath,
  });
  return entries.map((e) => ({
    name: e.name,
    remoteKey: e.path,
    relPath: "",
    size: e.size,
    lastModified: e.modified,
    isDir: e.isDir,
  }));
}

async function listOneWebdav(c: WebdavSyncCreds, url: string): Promise<RemoteEntry[]> {
  type WebdavEntry = { name: string; href: string; isDir: boolean; size: number; modified: number | null };
  const entries = await invoke<WebdavEntry[]>("webdav_list_dir", {
    url, username: c.username, password: c.password,
  });
  return entries.map((e) => ({
    name: e.name,
    remoteKey: e.href,
    relPath: "",
    size: e.size,
    lastModified: e.modified,
    isDir: e.isDir,
  }));
}

async function listOneBox(token: string, folderId: string): Promise<RemoteEntry[]> {
  type E = { id: string; name: string; isDir: boolean; size: number; modifiedAt: string | null };
  const entries = await invoke<E[]>("box_list_folder", { accessToken: token, folderId });
  return entries.map((e) => ({
    name: e.name, remoteKey: e.id, relPath: "", size: e.size,
    lastModified: isoToUnix(e.modifiedAt), isDir: e.isDir,
  }));
}

async function listOneDropbox(token: string, folderPath: string): Promise<RemoteEntry[]> {
  type E = { id: string; name: string; isDir: boolean; size: number; modified: string | null; pathDisplay: string };
  const entries = await invoke<E[]>("dropbox_list_folder", { accessToken: token, folderPath });
  return entries.map((e) => ({
    name: e.name, remoteKey: e.pathDisplay, relPath: "", size: e.size,
    lastModified: isoToUnix(e.modified), isDir: e.isDir,
  }));
}

async function listOneGcs(token: string, c: GcsSyncCreds, prefix: string): Promise<RemoteEntry[]> {
  type E = { key: string; name: string; isPrefix: boolean; size: number; updated: string | null };
  const entries = await invoke<E[]>("gcs_list_objects", { accessToken: token, bucket: c.bucket, prefix });
  return entries.map((e) => ({
    name: e.name, remoteKey: e.key, relPath: "", size: e.size,
    lastModified: isoToUnix(e.updated), isDir: e.isPrefix,
  }));
}

async function listOneGdrive(token: string, folderId: string): Promise<RemoteEntry[]> {
  type E = { id: string; name: string; isDir: boolean; isGoogleDoc: boolean; size: number; modified: string | null; mimeType: string | null };
  const entries = await invoke<E[]>("gdrive_list_files", { accessToken: token, folderId });
  // Google ドキュメント（直接ダウンロード不可・サイズ不定）は同期対象外。
  return entries
    .filter((e) => e.isDir || !e.isGoogleDoc)
    .map((e) => ({
      name: e.name, remoteKey: e.id, relPath: "", size: e.size,
      lastModified: isoToUnix(e.modified), isDir: e.isDir, mimeType: e.mimeType ?? undefined,
    }));
}

async function listOneOnedrive(token: string, folderId: string): Promise<RemoteEntry[]> {
  type E = { id: string; name: string; isDir: boolean; size: number; modified: string | null; mimeType: string | null };
  const entries = await invoke<E[]>("onedrive_list_files", { accessToken: token, folderId });
  return entries.map((e) => ({
    name: e.name, remoteKey: e.id, relPath: "", size: e.size,
    lastModified: isoToUnix(e.modified), isDir: e.isDir,
  }));
}

/** プロバイダ共通: 1階層を列挙する。childPath は親ディレクトリの remoteKey（再帰用）。 */
async function listRemoteLevel(
  job: CloudSyncJob,
  childPath: string | null,
  token: string,
): Promise<RemoteEntry[]> {
  if (job.provider === "s3" && job.s3) {
    // S3: childPath はプレフィックス。ルートは prefix+"/"。
    const prefix = childPath ?? (job.s3.prefix ? `${job.s3.prefix}/` : "");
    return listOneS3(job.s3, prefix);
  }
  if (job.provider === "azblob" && job.azblob) {
    const prefix = childPath ?? (job.azblob.prefix ? `${job.azblob.prefix.replace(/\/$/, "")}/` : "");
    return listOneAzblob(job.azblob, prefix);
  }
  if (job.provider === "sftp" && job.sftp) {
    return listOneSftp(job.sftp, childPath ?? job.sftp.remotePath);
  }
  if (job.provider === "webdav" && job.webdav) {
    return listOneWebdav(job.webdav, childPath ?? job.webdav.url);
  }
  if (job.provider === "box" && job.box) {
    return listOneBox(token, childPath ?? job.box.rootFolderId);
  }
  if (job.provider === "dropbox" && job.dropbox) {
    return listOneDropbox(token, childPath ?? job.dropbox.rootPath);
  }
  if (job.provider === "gcs" && job.gcs) {
    const prefix = childPath ?? (job.gcs.prefix ? `${job.gcs.prefix.replace(/\/$/, "")}/` : "");
    return listOneGcs(token, job.gcs, prefix);
  }
  if (job.provider === "gdrive" && job.gdrive) {
    return listOneGdrive(token, childPath ?? job.gdrive.rootFolderId);
  }
  if (job.provider === "onedrive" && job.onedrive) {
    return listOneOnedrive(token, childPath ?? job.onedrive.rootFolderId);
  }
  return [];
}

/** リモートを（必要なら再帰的に）列挙してファイルだけを返す。 */
async function listRemoteAll(job: CloudSyncJob, recursive: boolean, token: string): Promise<RemoteEntry[]> {
  const out: RemoteEntry[] = [];
  async function walk(childPath: string | null, rel: string, depth: number): Promise<void> {
    if (depth > MAX_RECURSION_DEPTH) return;
    const entries = await listRemoteLevel(job, childPath, token);
    for (const e of entries) {
      const entryRel = joinRel(rel, e.name);
      if (e.isDir) {
        if (recursive) await walk(e.remoteKey, entryRel, depth + 1);
      } else {
        out.push({ ...e, relPath: entryRel });
      }
    }
  }
  await walk(null, "", 0);
  return out;
}

// ── ローカルエントリ一覧 ─────────────────────────────────────────────
type RawLocal = { name: string; path: string; isDir: boolean; size: number; modified: number | null };

async function listLocalAll(rootPath: string, recursive: boolean): Promise<LocalEntry[]> {
  type ReadDirResult = { path: string; entries: RawLocal[] };
  const out: LocalEntry[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > MAX_RECURSION_DEPTH) return;
    let res: ReadDirResult;
    try {
      res = await invoke<ReadDirResult>("read_dir", { path: dir });
    } catch {
      return;
    }
    for (const e of res.entries) {
      const entryRel = joinRel(rel, e.name);
      if (e.isDir) {
        if (recursive) await walk(e.path, entryRel, depth + 1);
      } else {
        out.push({ name: e.name, path: e.path, relPath: entryRel, size: e.size, modified: e.modified });
      }
    }
  }
  await walk(rootPath, "", 0);
  return out;
}

// ── diff 計算 ────────────────────────────────────────────────────────
// キーは relPath（再帰時はサブディレクトリを含む相対パス）。
export function computeDiff(remote: RemoteEntry[], local: LocalEntry[]): SyncDiffItem[] {
  const remoteMap = new Map(remote.map((e) => [e.relPath, e]));
  const localMap = new Map(local.map((e) => [e.relPath, e]));
  const allKeys = new Set([...remoteMap.keys(), ...localMap.keys()]);
  const result: SyncDiffItem[] = [];

  for (const key of allKeys) {
    const r = remoteMap.get(key) ?? null;
    const l = localMap.get(key) ?? null;

    if (!r && l) {
      result.push({ name: key, direction: "upload", remote: null, local: l });
    } else if (r && !l) {
      result.push({ name: key, direction: "download", remote: r, local: null });
    } else if (r && l) {
      // どちらが新しいかを lastModified/modified で判断
      const rMod = r.lastModified ?? 0;
      const lMod = l.modified ?? 0;
      if (rMod > lMod + 5) {
        result.push({ name: key, direction: "download", remote: r, local: l });
      } else if (lMod > rMod + 5) {
        result.push({ name: key, direction: "upload", remote: r, local: l });
      } else {
        result.push({ name: key, direction: "same", remote: r, local: l });
      }
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ── プロバイダ別: ダウンロード ────────────────────────────────────────
async function downloadOneS3(c: S3SyncCreds, remoteKey: string, localPath: string) {
  await invoke("s3_download_object", {
    accessKey: c.accessKey, secretKey: c.secretKey, region: c.region,
    endpoint: c.endpoint || null, bucket: c.bucket, key: remoteKey, localPath,
  });
}

async function downloadOneAzblob(c: AzblobSyncCreds, remoteKey: string, localPath: string) {
  await invoke("azblob_download_object", {
    account: c.account, container: c.container, sasToken: c.sasToken,
    endpoint: c.endpoint || null, key: remoteKey, localPath,
  });
}

async function downloadOneSftp(c: SftpSyncCreds, remoteKey: string, localPath: string) {
  // Rust シグネチャ: host, port, user, password, remotePath, localPath
  await invoke("sftp_download", {
    host: c.host, port: c.port, user: c.username, password: c.password,
    remotePath: remoteKey, localPath,
  });
}

async function downloadOneWebdav(c: WebdavSyncCreds, remoteUrl: string, localDir: string, fileName: string) {
  // Rust シグネチャ: url, username, password, localDir, filename
  await invoke("webdav_download", {
    url: remoteUrl, username: c.username, password: c.password, localDir, filename: fileName,
  });
}

// ── プロバイダ別（OAuth）: ダウンロード ──────────────────────────────
// localPath は保存先ファイルのフルパス。各 Rust コマンドは localPath が既存ディレクトリ
// でなければそのままファイルパスとして使う。

async function downloadOneBox(token: string, fileId: string, fileName: string, localPath: string) {
  await invoke("box_download_file", { accessToken: token, fileId, fileName, localPath });
}
async function downloadOneDropbox(token: string, path: string, fileName: string, localPath: string) {
  await invoke("dropbox_download_file", { accessToken: token, path, fileName, localPath });
}
async function downloadOneGcs(token: string, c: GcsSyncCreds, key: string, localPath: string) {
  await invoke("gcs_download_object", { accessToken: token, bucket: c.bucket, key, localPath });
}
async function downloadOneGdrive(token: string, fileId: string, fileName: string, mimeType: string, localPath: string) {
  await invoke("gdrive_download_file", { accessToken: token, fileId, fileName, mimeType, localPath });
}
async function downloadOneOnedrive(token: string, fileId: string, fileName: string, localPath: string) {
  await invoke("onedrive_download_file", { accessToken: token, fileId, fileName, localPath });
}

// ── ID ベース（box/gdrive/onedrive）のサブフォルダ ID 解決 ──────────────
// relDir（POSIX, 例 "a/b"）に対応するリモートフォルダ ID を返す。途中のフォルダが
// 無ければ作成する。1 回のアップロード同期内で folderCache に結果をためる。
async function resolveFolderId(
  rootId: string,
  relDir: string,
  folderCache: Map<string, string>,
  listChildren: (parentId: string) => Promise<RemoteEntry[]>,
  createChild: (parentId: string, name: string) => Promise<string>,
): Promise<string> {
  if (!relDir) return rootId;
  const parts = relDir.split("/");
  let parentId = rootId;
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const cachedId = folderCache.get(acc);
    if (cachedId) { parentId = cachedId; continue; }
    const children = await listChildren(parentId);
    const found = children.find((e) => e.isDir && e.name === part);
    const id = found ? found.remoteKey : await createChild(parentId, part);
    folderCache.set(acc, id);
    parentId = id;
  }
  return parentId;
}

// ── プロバイダ別: アップロード ────────────────────────────────────────
// relPath にはサブディレクトリを含む相対パス（POSIX 区切り）が入る。

async function uploadOneS3(c: S3SyncCreds, localPath: string, relPath: string) {
  // S3 はキーにスラッシュを含めるだけでサブパスになる（ディレクトリ作成不要）。
  const key = c.prefix ? `${c.prefix}/${relPath}` : relPath;
  await invoke("s3_upload_object", {
    accessKey: c.accessKey, secretKey: c.secretKey, region: c.region,
    endpoint: c.endpoint || null, bucket: c.bucket, key, localPath,
  });
}

async function uploadOneAzblob(c: AzblobSyncCreds, localPath: string, relPath: string) {
  // Azure Blob も key にスラッシュを含めるだけでサブパスになる。
  const key = c.prefix ? `${c.prefix.replace(/\/$/, "")}/${relPath}` : relPath;
  await invoke("azblob_upload_object", {
    account: c.account, container: c.container, sasToken: c.sasToken,
    endpoint: c.endpoint || null, key, localPath,
  });
}

async function uploadOneSftp(c: SftpSyncCreds, localPath: string, relPath: string) {
  const base = c.remotePath.replace(/\/$/, "");
  // サブディレクトリがある場合は事前に mkdir -p 相当を試みる（失敗は無視）。
  const slash = relPath.lastIndexOf("/");
  if (slash >= 0) {
    const subDir = relPath.slice(0, slash);
    await invoke("sftp_mkdirs", {
      host: c.host, port: c.port, user: c.username, password: c.password,
      remotePath: `${base}/${subDir}`,
    }).catch(() => {});
  }
  const remotePath = `${base}/${relPath}`;
  await invoke("sftp_upload", {
    host: c.host, port: c.port, user: c.username, password: c.password,
    localPath, remotePath,
  });
}

async function uploadOneWebdav(c: WebdavSyncCreds, localPath: string, relPath: string) {
  const base = c.url.replace(/\/$/, "");
  // サブディレクトリがある場合は MKCOL を階層的に試みる。
  // HTTP 405 (Method Not Allowed) / 409 (Conflict) は「既に存在 or 親が先に必要」
  // で実害が無いことが多いので無視するが、他のエラーは後段 PUT が失敗したとき
  // 原因切り分けできるよう最後に発生したものを保持する。
  const slash = relPath.lastIndexOf("/");
  let lastMkdirError: string | null = null;
  if (slash >= 0) {
    const parts = relPath.slice(0, slash).split("/");
    let acc = base;
    for (const p of parts) {
      acc = `${acc}/${p}`;
      try {
        await invoke("webdav_mkdir", {
          url: `${acc}/`, username: c.username, password: c.password,
        });
      } catch (e) {
        const msg = String(e);
        // "HTTP 405" "HTTP 409" は「既存ディレクトリ / 既存ファイル」で無害。
        if (!/HTTP\s+(405|409)/.test(msg)) {
          lastMkdirError = `mkdir ${acc}: ${msg}`;
        }
      }
    }
  }
  const remoteUrl = `${base}/${relPath}`;
  try {
    await invoke("webdav_upload", {
      url: remoteUrl, username: c.username, password: c.password, localPath,
    });
  } catch (e) {
    // PUT が失敗したとき、直前の MKCOL エラーがあれば添付して診断性を上げる。
    if (lastMkdirError) {
      throw new Error(`${e} (precondition failed: ${lastMkdirError})`);
    }
    throw e;
  }
}

// ── プロバイダ別（OAuth）: アップロード ──────────────────────────────

async function uploadOneBox(token: string, c: BoxSyncCreds, localPath: string, relPath: string, cache: Map<string, string>) {
  const folderId = await resolveFolderId(
    c.rootFolderId, dirOf(relPath), cache,
    (pid) => listOneBox(token, pid),
    (pid, name) => invoke<{ id: string }>("box_create_folder", { accessToken: token, parentId: pid, name }).then((r) => r.id),
  );
  await invoke("box_upload_file", { accessToken: token, folderId, localPath });
}

async function uploadOneDropbox(token: string, c: DropboxSyncCreds, localPath: string, relPath: string) {
  // Dropbox はアップロード時に親フォルダを自動作成するので mkdir 不要。
  const base = c.rootPath.replace(/\/$/, "");
  const relDir = dirOf(relPath);
  const folderPath = relDir ? `${base}/${relDir}` : base;
  await invoke("dropbox_upload_file", { accessToken: token, folderPath, localPath });
}

async function uploadOneGcs(token: string, c: GcsSyncCreds, localPath: string, relPath: string) {
  // GCS はキーにスラッシュを含めるだけ（ディレクトリ作成不要）。prefix にはファイル名直前まで。
  const base = c.prefix ? `${c.prefix.replace(/\/$/, "")}/` : "";
  const relDir = dirOf(relPath);
  const prefix = relDir ? `${base}${relDir}/` : base;
  await invoke("gcs_upload_object", { accessToken: token, bucket: c.bucket, prefix, localPath });
}

async function uploadOneGdrive(token: string, c: GdriveSyncCreds, localPath: string, relPath: string, cache: Map<string, string>) {
  const folderId = await resolveFolderId(
    c.rootFolderId, dirOf(relPath), cache,
    (pid) => listOneGdrive(token, pid),
    (pid, name) => invoke<{ id: string }>("gdrive_create_folder", { accessToken: token, parentId: pid, name }).then((r) => r.id),
  );
  await invoke("gdrive_upload_file", { accessToken: token, folderId, localPath });
}

async function uploadOneOnedrive(token: string, c: OnedriveSyncCreds, localPath: string, relPath: string, cache: Map<string, string>) {
  const folderId = await resolveFolderId(
    c.rootFolderId, dirOf(relPath), cache,
    (pid) => listOneOnedrive(token, pid),
    (pid, name) => invoke<{ id: string }>("onedrive_create_folder", { accessToken: token, parentId: pid, name }).then((r) => r.id),
  );
  await invoke("onedrive_upload_file", { accessToken: token, folderId, localPath });
}

// ── 公開 API ─────────────────────────────────────────────────────────

/** リモート/ローカルの生エントリと diff をまとめて返す（削除反映で使う）。 */
export async function fetchDiffDetailed(
  job: CloudSyncJob,
): Promise<{ remote: RemoteEntry[]; local: LocalEntry[]; diff: SyncDiffItem[] }> {
  const recursive = !!job.recursive;
  const token = await getAccessToken(job);
  const [remote, local] = await Promise.all([
    listRemoteAll(job, recursive, token),
    listLocalAll(job.localPath, recursive),
  ]);
  return { remote, local, diff: computeDiff(remote, local) };
}

/** リモートとローカルを列挙して diff を返す（副作用なし）。recursive 対応。 */
export async function fetchDiff(job: CloudSyncJob): Promise<SyncDiffItem[]> {
  return (await fetchDiffDetailed(job)).diff;
}

/** 同期履歴に 1 件記録する（e を渡すとエラー扱い）。 */
function recordHistory(
  job: CloudSyncJob,
  direction: SyncHistoryDirection,
  name: string,
  e?: unknown,
): void {
  recordSyncHistory({
    ts: Math.floor(Date.now() / 1000),
    jobId: job.id,
    jobName: job.name,
    provider: job.provider,
    direction,
    name,
    status: e === undefined ? "ok" : "error",
    ...(e === undefined ? {} : { error: String(e) }),
  });
}

/** ダウンロード同期（リモート優先）: direction="download" のファイルを取得。 */
export async function downloadSync(
  job: CloudSyncJob,
  diff: SyncDiffItem[],
  onProgress?: (name: string, done: number, total: number) => void,
): Promise<SyncResult> {
  const sep = job.localPath.includes("\\") ? "\\" : "/";
  const targets = diff.filter((d) => d.direction === "download" && d.remote);
  const result: SyncResult = { ok: 0, failed: 0, errors: [] };
  const token = await getAccessToken(job);

  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    // relPath を OS 区切りに変換してローカルパスを組む。
    const localRel = item.name.replace(/\//g, sep);
    const localPath = `${job.localPath}${sep}${localRel}`;
    // サブディレクトリがある場合は親を先に作成。
    const lastSep = localPath.lastIndexOf(sep);
    const localDir = lastSep > job.localPath.length ? localPath.slice(0, lastSep) : job.localPath;
    onProgress?.(item.name, i, targets.length);
    try {
      if (localDir !== job.localPath) {
        await invoke("create_dir", { path: localDir }).catch(() => {});
      }
      const r = item.remote!;
      if (job.provider === "s3" && job.s3)
        await downloadOneS3(job.s3, r.remoteKey, localPath);
      else if (job.provider === "azblob" && job.azblob)
        await downloadOneAzblob(job.azblob, r.remoteKey, localPath);
      else if (job.provider === "sftp" && job.sftp)
        await downloadOneSftp(job.sftp, r.remoteKey, localPath);
      else if (job.provider === "webdav" && job.webdav)
        await downloadOneWebdav(job.webdav, r.remoteKey, localDir, r.name);
      else if (job.provider === "box" && job.box)
        await downloadOneBox(token, r.remoteKey, r.name, localPath);
      else if (job.provider === "dropbox" && job.dropbox)
        await downloadOneDropbox(token, r.remoteKey, r.name, localPath);
      else if (job.provider === "gcs" && job.gcs)
        await downloadOneGcs(token, job.gcs, r.remoteKey, localPath);
      else if (job.provider === "gdrive" && job.gdrive)
        await downloadOneGdrive(token, r.remoteKey, r.name, r.mimeType ?? "", localPath);
      else if (job.provider === "onedrive" && job.onedrive)
        await downloadOneOnedrive(token, r.remoteKey, r.name, localPath);
      result.ok++;
      recordHistory(job, "download", item.name);
    } catch (e) {
      result.failed++;
      result.errors.push(`${item.name}: ${e}`);
      recordHistory(job, "download", item.name, e);
    }
  }
  return result;
}

/** アップロード同期（ローカル優先）: direction="upload" のファイルを送信。 */
export async function uploadSync(
  job: CloudSyncJob,
  diff: SyncDiffItem[],
  onProgress?: (name: string, done: number, total: number) => void,
): Promise<SyncResult> {
  const targets = diff.filter((d) => d.direction === "upload" && d.local);
  const result: SyncResult = { ok: 0, failed: 0, errors: [] };
  const token = await getAccessToken(job);
  // ID ベース（box/gdrive/onedrive）のサブフォルダ ID をこの同期内でキャッシュ。
  const folderCache = new Map<string, string>();

  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    onProgress?.(item.name, i, targets.length);
    try {
      // item.name は relPath（再帰時はサブパスを含む）。各ヘルパが relPath を解釈する。
      const lp = item.local!.path;
      const rel = item.local!.relPath;
      if (job.provider === "s3" && job.s3)
        await uploadOneS3(job.s3, lp, rel);
      else if (job.provider === "azblob" && job.azblob)
        await uploadOneAzblob(job.azblob, lp, rel);
      else if (job.provider === "sftp" && job.sftp)
        await uploadOneSftp(job.sftp, lp, rel);
      else if (job.provider === "webdav" && job.webdav)
        await uploadOneWebdav(job.webdav, lp, rel);
      else if (job.provider === "box" && job.box)
        await uploadOneBox(token, job.box, lp, rel, folderCache);
      else if (job.provider === "dropbox" && job.dropbox)
        await uploadOneDropbox(token, job.dropbox, lp, rel);
      else if (job.provider === "gcs" && job.gcs)
        await uploadOneGcs(token, job.gcs, lp, rel);
      else if (job.provider === "gdrive" && job.gdrive)
        await uploadOneGdrive(token, job.gdrive, lp, rel, folderCache);
      else if (job.provider === "onedrive" && job.onedrive)
        await uploadOneOnedrive(token, job.onedrive, lp, rel, folderCache);
      result.ok++;
      recordHistory(job, "upload", item.name);
    } catch (e) {
      result.failed++;
      result.errors.push(`${item.name}: ${e}`);
      recordHistory(job, "upload", item.name, e);
    }
  }
  return result;
}

/**
 * 双方向同期: 同一 diff に対して download と upload の両方を実行する。
 * - download = リモートが新しいファイルをローカルへ
 * - upload   = ローカルが新しいファイルをリモートへ
 * 方向は computeDiff が lastModified 比較で決めるので衝突しない
 * （1ファイルは download か upload のどちらか一方にしか分類されない）。
 */
export async function bidirectionalSync(
  job: CloudSyncJob,
  diff: SyncDiffItem[],
  onProgress?: (name: string, done: number, total: number) => void,
): Promise<SyncResult> {
  const dl = await downloadSync(job, diff, onProgress);
  const ul = await uploadSync(job, diff, onProgress);
  return {
    ok: dl.ok + ul.ok,
    failed: dl.failed + ul.failed,
    errors: [...dl.errors, ...ul.errors],
  };
}

// ── 削除の双方向反映 ─────────────────────────────────────────────────

/** リモートの1ファイルを削除する。token は OAuth プロバイダのアクセストークン。 */
async function deleteRemote(job: CloudSyncJob, entry: RemoteEntry, token: string): Promise<void> {
  if (job.provider === "s3" && job.s3) {
    await invoke("s3_delete_object", {
      accessKey: job.s3.accessKey, secretKey: job.s3.secretKey, region: job.s3.region,
      endpoint: job.s3.endpoint || null, bucket: job.s3.bucket, key: entry.remoteKey,
    });
  } else if (job.provider === "azblob" && job.azblob) {
    await invoke("azblob_delete_object", {
      account: job.azblob.account, container: job.azblob.container, sasToken: job.azblob.sasToken,
      endpoint: job.azblob.endpoint || null, key: entry.remoteKey,
    });
  } else if (job.provider === "sftp" && job.sftp) {
    await invoke("sftp_delete", {
      host: job.sftp.host, port: job.sftp.port, user: job.sftp.username,
      password: job.sftp.password, remotePath: entry.remoteKey,
    });
  } else if (job.provider === "webdav" && job.webdav) {
    await invoke("webdav_delete", {
      url: entry.remoteKey, username: job.webdav.username, password: job.webdav.password,
    });
  } else if (job.provider === "box" && job.box) {
    await invoke("box_delete_item", { accessToken: token, itemId: entry.remoteKey, isDir: false });
  } else if (job.provider === "dropbox" && job.dropbox) {
    await invoke("dropbox_delete_item", { accessToken: token, path: entry.remoteKey });
  } else if (job.provider === "gcs" && job.gcs) {
    await invoke("gcs_delete_object", { accessToken: token, bucket: job.gcs.bucket, key: entry.remoteKey });
  } else if (job.provider === "gdrive" && job.gdrive) {
    await invoke("gdrive_delete_file", { accessToken: token, fileId: entry.remoteKey });
  } else if (job.provider === "onedrive" && job.onedrive) {
    await invoke("onedrive_delete_file", { accessToken: token, fileId: entry.remoteKey });
  }
}

/** ローカルの1ファイルを削除する（安全のため OS ゴミ箱へ）。 */
async function deleteLocal(path: string): Promise<void> {
  await invoke("delete_item", { path, trash: true });
  // 同期エンジンは React の外なのでストアを直接触れない。
  // 削除を通知して、タグ・カラーラベルの紐づけを捨ててもらう。
  window.dispatchEvent(new CustomEvent(APP_EVENTS.PATHS_DELETED, { detail: { paths: [path] } }));
}

export type DeleteSyncResult = SyncResult & {
  /** 今回両側に存在するファイルの relPath（次回スナップショットに使う）。 */
  presentPaths: string[];
};

/**
 * 削除の双方向反映。スナップショット差分方式:
 * - prevPaths（前回両側に存在）にあったファイルが、
 *   - 今回リモートから消えた → ローカル側も削除（ゴミ箱）
 *   - 今回ローカルから消えた → リモート側も削除
 * - download/upload モードでは消えた側の方向だけ反映（リモート削除はローカルへ、等）
 * 返り値の presentPaths は「今回 remote ∩ local」で、次回の prevPaths になる。
 */
export async function deleteSync(
  job: CloudSyncJob,
  remote: RemoteEntry[],
  local: LocalEntry[],
  prevPaths: string[],
): Promise<DeleteSyncResult> {
  const result: DeleteSyncResult = { ok: 0, failed: 0, errors: [], presentPaths: [] };
  const remoteMap = new Map(remote.map((e) => [e.relPath, e]));
  const localSet = new Set(local.map((e) => [e.relPath, e] as const).map(([k]) => k));
  const localMap = new Map(local.map((e) => [e.relPath, e]));
  const token = await getAccessToken(job);

  for (const rel of prevPaths) {
    const inRemote = remoteMap.has(rel);
    const inLocal = localSet.has(rel);
    if (inRemote === inLocal) continue; // 両方在/両方無は対象外

    try {
      if (!inRemote && inLocal) {
        // リモートから消えた → ローカルを削除（download / bidirectional のみ）
        if (job.syncMode === "download" || job.syncMode === "bidirectional") {
          await deleteLocal(localMap.get(rel)!.path);
          result.ok++;
          recordHistory(job, "deleteLocal", rel);
        }
      } else if (inRemote && !inLocal) {
        // ローカルから消えた → リモートを削除（upload / bidirectional のみ）
        if (job.syncMode === "upload" || job.syncMode === "bidirectional") {
          await deleteRemote(job, remoteMap.get(rel)!, token);
          result.ok++;
          recordHistory(job, "deleteRemote", rel);
        }
      }
    } catch (e) {
      result.failed++;
      result.errors.push(`${rel}: ${e}`);
      recordHistory(job, !inRemote && inLocal ? "deleteLocal" : "deleteRemote", rel, e);
    }
  }

  // 次回スナップショット = 今回両側に存在するもの
  for (const rel of remoteMap.keys()) {
    if (localSet.has(rel)) result.presentPaths.push(rel);
  }
  return result;
}

/**
 * syncMode に応じて自動同期を実行する（ポーリングから呼ぶ統一エントリ）。
 * deletePropagation が有効なら削除反映も行い、スナップショットを返す。
 */
export async function runAutoSync(
  job: CloudSyncJob,
): Promise<SyncResult & { nextSnapshot?: string[] }> {
  const { remote, local, diff } = await fetchDiffDetailed(job);

  // まず削除反映（コピー前に行う: 消えたファイルを誤って復元しないため）
  let delResult: DeleteSyncResult | null = null;
  let transferDiff = diff;
  if (job.deletePropagation) {
    const prevPaths = job.lastSyncedPaths ?? [];
    delResult = await deleteSync(job, remote, local, prevPaths);
    // 削除を反映したので、削除済みエントリを diff から除外して転送する。
    // - bidirectional + remote 側削除 → ローカル削除済み。元 diff は upload 方向だが
    //   ローカルファイルは既に無いので uploadSync が「存在しないファイル」エラーを出す。
    // - bidirectional + local 側削除 → リモート削除済み。元 diff は download 方向だが
    //   リモートが無くなったため downloadSync が 404 等で失敗する。
    // どちらも prevPaths にあったエントリが「片側のみ存在」状態だったケースなので、
    // prevPaths に入っていて今回 inRemote XOR inLocal なら除外。
    const remoteSet = new Set(remote.map((e) => e.relPath));
    const localSet = new Set(local.map((e) => e.relPath));
    const deletedRels = new Set(
      prevPaths.filter((rel) => remoteSet.has(rel) !== localSet.has(rel)),
    );
    if (deletedRels.size > 0) {
      transferDiff = diff.filter((d) => !deletedRels.has(d.name));
    }
  }

  // 残りのファイルを転送
  let transfer: SyncResult;
  if (job.syncMode === "upload") transfer = await uploadSync(job, transferDiff);
  else if (job.syncMode === "bidirectional") transfer = await bidirectionalSync(job, transferDiff);
  else transfer = await downloadSync(job, transferDiff);

  // 転送後の最終状態でスナップショットを取り直す（削除・転送の結果を反映）
  let nextSnapshot: string[] | undefined;
  if (job.deletePropagation) {
    try {
      const after = await fetchDiffDetailed(job);
      const localSet = new Set(after.local.map((e) => e.relPath));
      nextSnapshot = after.remote.map((e) => e.relPath).filter((r) => localSet.has(r));
    } catch {
      nextSnapshot = delResult?.presentPaths;
    }
  }

  return {
    ok: transfer.ok + (delResult?.ok ?? 0),
    failed: transfer.failed + (delResult?.failed ?? 0),
    errors: [...(delResult?.errors ?? []), ...transfer.errors],
    nextSnapshot,
  };
}

// ── 手動ファイル転送（クライアント風ブラウズ） ─────────────────────────
// 自動の差分同期とは別に、リモートの 1 階層を閲覧し、選択ファイルを個別に
// ダウンロード / アップロードするための API。CloudSyncPanel のブラウズ UI が使う。

/**
 * リモートの 1 階層（ファイル＋ディレクトリ）を列挙する。
 * childKey=null のときはジョブ設定のルートを列挙する。
 */
export async function listRemoteDir(
  job: CloudSyncJob,
  childKey: string | null,
): Promise<RemoteEntry[]> {
  const token = await getAccessToken(job);
  const entries = await listRemoteLevel(job, childKey, token);
  // ディレクトリ優先・名前順に整える（プロバイダ間で表示を揃える）。
  return entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
}

/** リモートの 1 ファイルを localDir 直下へダウンロードする。 */
export async function downloadEntry(
  job: CloudSyncJob,
  entry: RemoteEntry,
  localDir: string,
): Promise<void> {
  const token = await getAccessToken(job);
  const sep = localDir.includes("\\") ? "\\" : "/";
  const base = localDir.replace(/[/\\]$/, "");
  const localPath = `${base}${sep}${entry.name}`;
  if (job.provider === "s3" && job.s3) await downloadOneS3(job.s3, entry.remoteKey, localPath);
  else if (job.provider === "azblob" && job.azblob) await downloadOneAzblob(job.azblob, entry.remoteKey, localPath);
  else if (job.provider === "sftp" && job.sftp) await downloadOneSftp(job.sftp, entry.remoteKey, localPath);
  else if (job.provider === "webdav" && job.webdav) await downloadOneWebdav(job.webdav, entry.remoteKey, base, entry.name);
  else if (job.provider === "box" && job.box) await downloadOneBox(token, entry.remoteKey, entry.name, localPath);
  else if (job.provider === "dropbox" && job.dropbox) await downloadOneDropbox(token, entry.remoteKey, entry.name, localPath);
  else if (job.provider === "gcs" && job.gcs) await downloadOneGcs(token, job.gcs, entry.remoteKey, localPath);
  else if (job.provider === "gdrive" && job.gdrive) await downloadOneGdrive(token, entry.remoteKey, entry.name, entry.mimeType ?? "", localPath);
  else if (job.provider === "onedrive" && job.onedrive) await downloadOneOnedrive(token, entry.remoteKey, entry.name, localPath);
}

/**
 * ローカルの 1 ファイルを、現在ブラウズ中のリモートディレクトリへアップロードする。
 * dirKey=null のときはジョブ設定のルートへ送る。dirKey は listRemoteDir で辿った
 * ディレクトリの remoteKey（S3/GCS はプレフィックス、SFTP/WebDAV はパス/URL、
 * box/gdrive/onedrive はフォルダ ID、Dropbox はパス）。
 */
export async function uploadFileToRemoteDir(
  job: CloudSyncJob,
  localPath: string,
  dirKey: string | null,
): Promise<void> {
  const token = await getAccessToken(job);
  const fileName = localPath.split(/[/\\]/).pop() || localPath;
  if (job.provider === "s3" && job.s3) {
    // dirKey はプレフィックス（末尾 "/" 付きのことがある）。キー = dirKey + filename。
    const base = (dirKey ?? (job.s3.prefix ? `${job.s3.prefix}/` : "")).replace(/\/$/, "");
    const key = base ? `${base}/${fileName}` : fileName;
    await invoke("s3_upload_object", {
      accessKey: job.s3.accessKey, secretKey: job.s3.secretKey, region: job.s3.region,
      endpoint: job.s3.endpoint || null, bucket: job.s3.bucket, key, localPath,
    });
  } else if (job.provider === "azblob" && job.azblob) {
    const base = (dirKey ?? (job.azblob.prefix ? `${job.azblob.prefix}/` : "")).replace(/\/$/, "");
    const key = base ? `${base}/${fileName}` : fileName;
    await invoke("azblob_upload_object", {
      account: job.azblob.account, container: job.azblob.container, sasToken: job.azblob.sasToken,
      endpoint: job.azblob.endpoint || null, key, localPath,
    });
  } else if (job.provider === "sftp" && job.sftp) {
    const remotePath = (dirKey ?? job.sftp.remotePath).replace(/\/$/, "");
    await invoke("sftp_upload", {
      host: job.sftp.host, port: job.sftp.port, user: job.sftp.username,
      password: job.sftp.password, localPath, remotePath: `${remotePath}/${fileName}`,
    });
  } else if (job.provider === "webdav" && job.webdav) {
    const base = (dirKey ?? job.webdav.url).replace(/\/$/, "");
    await invoke("webdav_upload", {
      url: `${base}/${fileName}`, username: job.webdav.username, password: job.webdav.password, localPath,
    });
  } else if (job.provider === "box" && job.box) {
    await invoke("box_upload_file", { accessToken: token, folderId: dirKey ?? job.box.rootFolderId, localPath });
  } else if (job.provider === "dropbox" && job.dropbox) {
    await invoke("dropbox_upload_file", { accessToken: token, folderPath: dirKey ?? job.dropbox.rootPath, localPath });
  } else if (job.provider === "gcs" && job.gcs) {
    const prefix = dirKey ?? (job.gcs.prefix ? `${job.gcs.prefix.replace(/\/$/, "")}/` : "");
    await invoke("gcs_upload_object", { accessToken: token, bucket: job.gcs.bucket, prefix, localPath });
  } else if (job.provider === "gdrive" && job.gdrive) {
    await invoke("gdrive_upload_file", { accessToken: token, folderId: dirKey ?? job.gdrive.rootFolderId, localPath });
  } else if (job.provider === "onedrive" && job.onedrive) {
    await invoke("onedrive_upload_file", { accessToken: token, folderId: dirKey ?? job.onedrive.rootFolderId, localPath });
  }
}
