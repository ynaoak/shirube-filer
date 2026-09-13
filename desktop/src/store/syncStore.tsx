import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { setCredsUpdater } from "../lib/cloudSyncEngine";
import { showToast } from "../lib/toast";
import i18n from "../i18n";

export type SyncProvider =
  | "s3"
  | "azblob"
  | "sftp"
  | "webdav"
  | "box"
  | "dropbox"
  | "gcs"
  | "gdrive"
  | "onedrive";

/** OAuth 2.0（PKCE）でリフレッシュトークンを用いるプロバイダ。 */
export const OAUTH_PROVIDERS: SyncProvider[] = ["box", "dropbox", "gcs", "gdrive", "onedrive"];

/** 自動ポーリング時の同期方向。 */
export type SyncMode = "download" | "upload" | "bidirectional";

export type S3SyncCreds = {
  accessKey: string;
  secretKey: string;
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
};

/** Azure Blob Storage（SAS トークン認証）。endpoint 空=既定の *.blob.core.windows.net。 */
export type AzblobSyncCreds = {
  account: string;
  container: string;
  sasToken: string;
  prefix: string;
  endpoint: string;
};

export type SftpSyncCreds = {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
};

export type WebdavSyncCreds = {
  url: string;
  username: string;
  password: string;
};

// ── OAuth プロバイダの認証情報 ────────────────────────────────────────
// 秘匿値は refreshToken のみ（OS キーチェーンへ保存）。アクセストークンは
// 同期エンジンが refreshToken から都度発行・キャッシュするため保持しない。

/** Box（ID ベース）。rootFolderId 既定 "0"（Box ルート）。 */
export type BoxSyncCreds = {
  refreshToken: string;
  rootFolderId: string;
};

/** Dropbox（パスベース）。rootPath 既定 ""（ルート）。 */
export type DropboxSyncCreds = {
  refreshToken: string;
  rootPath: string;
};

/** Google Cloud Storage（キー/プレフィックス、S3 互換的）。 */
export type GcsSyncCreds = {
  refreshToken: string;
  bucket: string;
  prefix: string;
};

/** Google Drive（ID ベース）。rootFolderId 既定 "root"。 */
export type GdriveSyncCreds = {
  refreshToken: string;
  rootFolderId: string;
};

/** OneDrive（ID ベース）。rootFolderId 既定 "root"。 */
export type OnedriveSyncCreds = {
  refreshToken: string;
  rootFolderId: string;
};

export type CloudSyncJob = {
  id: string;
  name: string;
  enabled: boolean;
  provider: SyncProvider;
  localPath: string;
  /** 表示用のグループ名（任意）。未設定・空文字は「未分類」扱い。 */
  group?: string;
  s3?: S3SyncCreds;
  azblob?: AzblobSyncCreds;
  sftp?: SftpSyncCreds;
  webdav?: WebdavSyncCreds;
  box?: BoxSyncCreds;
  dropbox?: DropboxSyncCreds;
  gcs?: GcsSyncCreds;
  gdrive?: GdriveSyncCreds;
  onedrive?: OnedriveSyncCreds;
  /** 自動ダウンロードのポーリング間隔（分）。0 = 無効。 */
  autoDownloadInterval: number;
  /** サブディレクトリを再帰的に同期するか。 */
  recursive: boolean;
  /** 自動ポーリング時の同期方向。 */
  syncMode: SyncMode;
  /** 削除の双方向反映を有効にするか（既定 false）。 */
  deletePropagation: boolean;
  /** 前回同期時に両側に存在したファイルの relPath スナップショット（削除検出用）。 */
  lastSyncedPaths: string[];
  lastSyncedAt: number | null;
};

type SyncContextValue = {
  jobs: CloudSyncJob[];
  loaded: boolean;
  addJob: (job: CloudSyncJob) => void;
  updateJob: (id: string, patch: Partial<CloudSyncJob>) => void;
  removeJob: (id: string) => void;
  /** ドラッグ＆ドロップ並べ替え: id のジョブを targetId の前（before=true）/後ろへ移動。 */
  moveJob: (id: string, targetId: string, before: boolean) => void;
};

const SyncContext = createContext<SyncContextValue | null>(null);

// ── シークレットのキーチェーン連携 ───────────────────────────────────
// 各プロバイダの「秘匿フィールド」を OS キーチェーンに保管し、YAML には
// 空文字で書き出す（cloud-sync.yaml に平文を残さない）。
// account キーは `<jobId>:<provider>.<field>`。

type SecretField = { provider: SyncProvider; key: string };
const SECRET_FIELDS: SecretField[] = [
  { provider: "s3", key: "secretKey" },
  { provider: "azblob", key: "sasToken" },
  { provider: "sftp", key: "password" },
  { provider: "webdav", key: "password" },
  { provider: "box", key: "refreshToken" },
  { provider: "dropbox", key: "refreshToken" },
  { provider: "gcs", key: "refreshToken" },
  { provider: "gdrive", key: "refreshToken" },
  { provider: "onedrive", key: "refreshToken" },
];

function secretAccount(jobId: string, provider: SyncProvider, field: string): string {
  return `${jobId}:${provider}.${field}`;
}

/** ジョブから秘匿フィールドの現在値を取り出す（無ければ ""）。 */
function readSecretField(job: CloudSyncJob, f: SecretField): string {
  if (f.provider !== job.provider) return "";
  const creds = (job as unknown as Record<string, Record<string, string> | undefined>)[f.provider];
  return creds?.[f.key] ?? "";
}

/** ジョブの秘匿フィールドを空文字に置換したコピーを返す（YAML 保存用）。 */
function stripSecrets(job: CloudSyncJob): CloudSyncJob {
  const copy: CloudSyncJob = JSON.parse(JSON.stringify(job));
  for (const f of SECRET_FIELDS) {
    if (f.provider !== copy.provider) continue;
    const creds = (copy as unknown as Record<string, Record<string, string> | undefined>)[f.provider];
    if (creds && f.key in creds) creds[f.key] = "";
  }
  return copy;
}

/** 全ジョブの秘匿フィールドをキーチェーンへ書き込む（空なら削除）。 */
async function persistSecrets(jobs: CloudSyncJob[]): Promise<void> {
  await Promise.all(
    jobs.flatMap((job) =>
      SECRET_FIELDS.filter((f) => f.provider === job.provider).map(async (f) => {
        const account = secretAccount(job.id, f.provider, f.key);
        const value = readSecretField(job, f);
        try {
          if (value) await invoke("secret_set", { account, secret: value });
          else await invoke("secret_delete", { account });
        } catch {
          /* キーチェーン不可な環境（CI 等）では無視 */
        }
      }),
    ),
  );
}

/** ロード済みジョブの秘匿フィールドをキーチェーンから補完する。 */
async function fillSecrets(jobs: CloudSyncJob[]): Promise<CloudSyncJob[]> {
  return Promise.all(
    jobs.map(async (job) => {
      const filled: CloudSyncJob = JSON.parse(JSON.stringify(job));
      for (const f of SECRET_FIELDS) {
        if (f.provider !== filled.provider) continue;
        const account = secretAccount(filled.id, f.provider, f.key);
        try {
          const v = await invoke<string | null>("secret_get", { account });
          if (v) {
            const creds = (filled as unknown as Record<string, Record<string, string> | undefined>)[f.provider];
            if (creds) creds[f.key] = v;
          }
        } catch {
          /* ignore */
        }
      }
      return filled;
    }),
  );
}

/** 削除されたジョブの全シークレットをキーチェーンから消す。 */
async function deleteSecrets(job: CloudSyncJob): Promise<void> {
  await Promise.all(
    SECRET_FIELDS.filter((f) => f.provider === job.provider).map((f) =>
      invoke("secret_delete", { account: secretAccount(job.id, f.provider, f.key) }).catch(() => {}),
    ),
  );
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist(next: CloudSyncJob[]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // シークレットはキーチェーンへ、YAML には秘匿フィールドを空にして保存。
    persistSecrets(next).catch(() => {});
    // 保存失敗を握りつぶすと「接続を追加したのに再起動で消える」事故に
    // 気付けないため、必ずトーストで可視化する。
    invoke("save_sync_jobs", { jobs: next.map(stripSecrets) }).catch((e) => {
      console.error("[save_sync_jobs]", e);
      showToast(i18n.t("cloudSync.saveFailed", { error: String(e) }));
    });
  }, 400);
}

export function newSyncJob(provider: SyncProvider = "s3"): CloudSyncJob {
  return {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    // ハードコードすると英語 UI でも日本語名になるため i18n を通す
    name: i18n.t("cloudSync.newConnectionName"),
    enabled: true,
    provider,
    localPath: "",
    autoDownloadInterval: 0,
    recursive: false,
    syncMode: "download",
    deletePropagation: false,
    lastSyncedPaths: [],
    lastSyncedAt: null,
    ...(provider === "s3" && {
      s3: { accessKey: "", secretKey: "", region: "us-east-1", endpoint: "", bucket: "", prefix: "" },
    }),
    ...(provider === "azblob" && {
      azblob: { account: "", container: "", sasToken: "", prefix: "", endpoint: "" },
    }),
    ...(provider === "sftp" && {
      sftp: { host: "", port: 22, username: "", password: "", remotePath: "/" },
    }),
    ...(provider === "webdav" && {
      webdav: { url: "", username: "", password: "" },
    }),
    ...(provider === "box" && {
      box: { refreshToken: "", rootFolderId: "0" },
    }),
    ...(provider === "dropbox" && {
      dropbox: { refreshToken: "", rootPath: "" },
    }),
    ...(provider === "gcs" && {
      gcs: { refreshToken: "", bucket: "", prefix: "" },
    }),
    ...(provider === "gdrive" && {
      gdrive: { refreshToken: "", rootFolderId: "root" },
    }),
    ...(provider === "onedrive" && {
      onedrive: { refreshToken: "", rootFolderId: "root" },
    }),
  };
}

export function SyncProvider_({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<CloudSyncJob[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Box などリフレッシュトークンがローテーションするプロバイダのために、
  // 同期エンジンが新しいトークンを発行したら React 状態へ反映できるよう登録する。
  // （updateJob 経由で永続化されるため、編集時に古いトークンで上書きするのを防ぐ）
  const updateJobRef = useRef<(id: string, patch: Partial<CloudSyncJob>) => void>(() => {});

  useEffect(() => {
    invoke<CloudSyncJob[]>("load_sync_jobs")
      .then(async (j) => {
        if (!Array.isArray(j)) return;
        // 旧データに無いフィールドはフォールバック（後方互換）。
        const normalized = j.map((job) => ({
          ...job,
          syncMode: job.syncMode ?? "download",
          deletePropagation: job.deletePropagation ?? false,
          lastSyncedPaths: job.lastSyncedPaths ?? [],
        }));
        // キーチェーンから秘匿フィールドを補完。
        const filled = await fillSecrets(normalized);
        setJobs(filled);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const addJob = useCallback((job: CloudSyncJob) => {
    setJobs((prev) => { const next = [...prev, job]; persist(next); return next; });
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<CloudSyncJob>) => {
    setJobs((prev) => {
      const next = prev.map((j) => (j.id === id ? { ...j, ...patch } : j));
      persist(next);
      return next;
    });
  }, []);

  // 同期エンジンへ updateJob を登録（ローテーションしたリフレッシュトークンの反映用）。
  updateJobRef.current = updateJob;
  useEffect(() => {
    setCredsUpdater((id, patch) => updateJobRef.current(id, patch));
    return () => setCredsUpdater(null);
  }, []);

  const moveJob = useCallback((id: string, targetId: string, before: boolean) => {
    setJobs((prev) => {
      if (id === targetId) return prev;
      const from = prev.findIndex((j) => j.id === id);
      if (from < 0 || !prev.some((j) => j.id === targetId)) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      const at = next.findIndex((j) => j.id === targetId) + (before ? 0 : 1);
      next.splice(at, 0, moved);
      persist(next);
      return next;
    });
  }, []);

  const removeJob = useCallback((id: string) => {
    setJobs((prev) => {
      const removed = prev.find((j) => j.id === id);
      if (removed) deleteSecrets(removed).catch(() => {});
      const next = prev.filter((j) => j.id !== id);
      persist(next);
      return next;
    });
  }, []);

  return (
    <SyncContext.Provider value={{ jobs, loaded, addJob, updateJob, removeJob, moveJob }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncJobs(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSyncJobs must be used within SyncProvider_");
  return ctx;
}
