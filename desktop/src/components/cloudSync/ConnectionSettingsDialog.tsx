import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { CloudSyncJob, SyncMode } from "../../store/syncStore";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";
import ProviderBadge from "./ProviderBadge";
import { isOauth } from "./providerMeta";

// ── 接続設定ダイアログ ──────────────────────────────────────────────
// クラウド接続の「設定」（ローカルパス・プロバイダ別認証情報・同期方向/間隔・
// 再帰/削除伝播）をまとめたポップアップ。パネル側には「操作」のみを残す。
export default function ConnectionSettingsDialog({
  job, existingGroups, connecting, onChange, onConnect, onCancelConnect, onClose,
}: {
  job: CloudSyncJob;
  existingGroups: string[];
  connecting: boolean;
  onChange: (p: Partial<CloudSyncJob>) => void;
  onConnect: () => void;
  onCancelConnect: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // autoFocus は DOM 先頭の「閉じる」ボタンに当たってしまうため無効化し、
  // 代わりに接続名入力へ初期フォーカスを当てる。
  const dialogRef = useModal<HTMLDivElement>({ onClose, autoFocus: false });

  // 保存済みフラッシュ表示: ストア側は 400ms デバウンスで自動保存されるが、
  // 画面上ではそれが伝わらないため、変更のたびに一時的に「保存済み」を出す。
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const change = (p: Partial<CloudSyncJob>) => {
    onChange(p);
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1600);
  };

  const handlePickLocal = async () => {
    const p = await openDialog({ directory: true, multiple: false, defaultPath: job.localPath || undefined }).catch(() => null);
    if (typeof p === "string") change({ localPath: p });
  };

  return (
    <div
      className="kf-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("cloudSync.dialogTitle")}
        className="kf-anim-scale rounded-lg shadow-xl text-xs overflow-hidden flex flex-col"
        style={{
          width: 480,
          maxHeight: "80vh",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        {/* ヘッダー */}
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          <ProviderBadge provider={job.provider} size={20} />
          <span className="font-semibold flex-1 truncate">{t("cloudSync.dialogTitle")}</span>
          {savedFlash && (
            <span style={{ fontSize: 9, color: "var(--kf-success)" }}>
              <Icon name="check" size={10} className="inline align-text-bottom" /> {t("cloudSync.savedFlash")}
            </span>
          )}
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex items-center opacity-60 hover:opacity-100"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* 本文（スクロール可能） */}
        <div className="px-4 py-3 overflow-y-auto flex flex-col gap-2">
          <FRow label={t("cloudSync.connectionName")}>
            <TxtField value={job.name} onChange={(name) => change({ name })} autoFocus />
          </FRow>

          <FRow label={t("cloudSync.group")}>
            <input
              list="kf-sync-group-list"
              value={job.group ?? ""}
              onChange={(e) => change({ group: e.target.value || undefined })}
              placeholder={t("cloudSync.groupPlaceholder")}
              className="bg-transparent outline-none rounded px-1.5 py-0.5"
              style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
            />
            <datalist id="kf-sync-group-list">
              {existingGroups.map((g) => <option key={g} value={g} />)}
            </datalist>
          </FRow>

          {/* セクション見出し: 接続設定（ローカルパス〜プロバイダ別フィールド） */}
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--kf-text-muted)", marginTop: 2 }}>
            {t("cloudSync.sectionConnection")}
          </div>

          {/* Local path */}
          <FRow label={t("cloudSync.localDir")}>
            <div className="flex items-center gap-1">
              <input
                value={job.localPath}
                onChange={(e) => change({ localPath: e.target.value })}
                placeholder={t("cloudSync.localDirPlaceholder")}
                className="flex-1 bg-transparent outline-none rounded px-1.5 py-0.5"
                style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
              />
              <button onClick={handlePickLocal} className="flex items-center" style={{ color: "var(--kf-accent)" }} title={t("cloudSync.select")}>
                <Icon name="folder_open" size={13} />
              </button>
            </div>
          </FRow>

          {/* Provider-specific fields */}
          {job.provider === "s3" && job.s3 && (
            <S3Fields creds={job.s3} onChange={(s3) => change({ s3 })} />
          )}
          {job.provider === "azblob" && job.azblob && (
            <AzblobFields creds={job.azblob} onChange={(azblob) => change({ azblob })} />
          )}
          {job.provider === "sftp" && job.sftp && (
            <SftpFields creds={job.sftp} onChange={(sftp) => change({ sftp })} />
          )}
          {job.provider === "webdav" && job.webdav && (
            <WebdavFields creds={job.webdav} onChange={(webdav) => change({ webdav })} />
          )}
          {isOauth(job.provider) && (
            <OauthFields job={job} onChange={change} onConnect={onConnect} onCancelConnect={onCancelConnect} loading={connecting} />
          )}

          {/* セクション見出し: 同期設定（方向・間隔・再帰・削除伝播） */}
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--kf-text-muted)", marginTop: 2 }}>
            {t("cloudSync.sectionSync")}
          </div>

          {/* Sync direction */}
          <FRow label={t("cloudSync.syncDirection")}>
            <select
              value={job.syncMode}
              onChange={(e) => change({ syncMode: e.target.value as SyncMode })}
              className="bg-transparent outline-none rounded px-1.5 py-0.5"
              style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
            >
              <option value="download">{t("cloudSync.dirDownload")}</option>
              <option value="upload">{t("cloudSync.dirUpload")}</option>
              <option value="bidirectional">{t("cloudSync.dirBidirectional")}</option>
            </select>
          </FRow>

          {/* Auto-sync interval */}
          <FRow label={t("cloudSync.syncInterval")}>
            <input
              type="number" min={0} max={1440}
              value={job.autoDownloadInterval}
              onChange={(e) => change({ autoDownloadInterval: Math.max(0, parseInt(e.target.value) || 0) })}
              className="bg-transparent outline-none rounded px-1.5 py-0.5"
              style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)", width: 70 }}
            />
          </FRow>

          {/* Recursive */}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={job.recursive}
              onChange={(e) => change({ recursive: e.target.checked })}
            />
            <span>{t("cloudSync.recursive")}</span>
          </label>

          {/* Delete propagation */}
          <label className="flex items-start gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={job.deletePropagation}
              onChange={(e) => {
                if (e.target.checked && !window.confirm(t("cloudSync.deleteSyncConfirm"))) return;
                // 有効化時はスナップショットを今回基準でリセット（過去の削除を一括反映しない）。
                change({ deletePropagation: e.target.checked, lastSyncedPaths: [] });
              }}
              style={{ marginTop: 2 }}
            />
            <span>
              {t("cloudSync.deleteSyncLabel")}
              <span style={{ display: "block", color: "var(--kf-text-muted)", fontSize: 9 }}>
                {t("cloudSync.deleteSyncDesc")}
              </span>
            </span>
          </label>

          {/* 自動保存についての静的な注記 */}
          <div style={{ fontSize: 9, color: "var(--kf-text-muted)" }}>{t("cloudSync.autoSaveNote")}</div>
        </div>
      </div>
    </div>
  );
}

// ── Field components ────────────────────────────────────────────────
function FRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>{label}</span>
      {children}
    </label>
  );
}

function TxtField({ value, onChange, placeholder, type = "text", mono = false, autoFocus = false }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string; mono?: boolean; autoFocus?: boolean;
}) {
  return (
    <input
      type={type} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder} autoFocus={autoFocus}
      className="bg-transparent outline-none rounded px-1.5 py-0.5"
      style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)", fontFamily: mono ? "monospace" : undefined }}
    />
  );
}

function S3Fields({ creds, onChange }: { creds: NonNullable<CloudSyncJob["s3"]>; onChange: (v: NonNullable<CloudSyncJob["s3"]>) => void }) {
  const { t } = useTranslation();
  const f = (k: keyof typeof creds) => (v: string) => onChange({ ...creds, [k]: v });
  return (
    <>
      <FRow label={t("cloudSync.bucket")}><TxtField value={creds.bucket} onChange={f("bucket")} placeholder="my-bucket" /></FRow>
      <FRow label={t("cloudSync.prefix")}><TxtField value={creds.prefix} onChange={f("prefix")} placeholder="photos/2026" /></FRow>
      <FRow label={t("cloudSync.accessKey")}><TxtField value={creds.accessKey} onChange={f("accessKey")} mono /></FRow>
      <FRow label={t("cloudSync.secretKey")}><TxtField type="password" value={creds.secretKey} onChange={f("secretKey")} /></FRow>
      <FRow label={t("cloudSync.region")}><TxtField value={creds.region} onChange={f("region")} placeholder="us-east-1" /></FRow>
      <FRow label={t("cloudSync.endpoint")}><TxtField value={creds.endpoint} onChange={f("endpoint")} placeholder="https://r2.cloudflarestorage.com/..." /></FRow>
    </>
  );
}

function AzblobFields({ creds, onChange }: { creds: NonNullable<CloudSyncJob["azblob"]>; onChange: (v: NonNullable<CloudSyncJob["azblob"]>) => void }) {
  const { t } = useTranslation();
  const f = (k: keyof typeof creds) => (v: string) => onChange({ ...creds, [k]: v });
  return (
    <>
      <FRow label={t("cloudSync.azAccount")}><TxtField value={creds.account} onChange={f("account")} placeholder="mystorageacct" /></FRow>
      <FRow label={t("cloudSync.azContainer")}><TxtField value={creds.container} onChange={f("container")} placeholder="my-container" /></FRow>
      <FRow label={t("cloudSync.prefix")}><TxtField value={creds.prefix} onChange={f("prefix")} placeholder="photos/2026" /></FRow>
      <FRow label={t("cloudSync.azSasToken")}><TxtField type="password" value={creds.sasToken} onChange={f("sasToken")} placeholder="sv=...&sig=..." /></FRow>
      <FRow label={t("cloudSync.azEndpoint")}><TxtField value={creds.endpoint} onChange={f("endpoint")} placeholder="https://mystorageacct.blob.core.windows.net" /></FRow>
    </>
  );
}

function SftpFields({ creds, onChange }: { creds: NonNullable<CloudSyncJob["sftp"]>; onChange: (v: NonNullable<CloudSyncJob["sftp"]>) => void }) {
  const { t } = useTranslation();
  const f = (k: keyof typeof creds) => (v: string | number) => onChange({ ...creds, [k]: v });
  return (
    <>
      <FRow label={t("cloudSync.host")}><TxtField value={creds.host} onChange={(v) => f("host")(v)} placeholder="sftp.example.com" /></FRow>
      <div className="flex gap-2">
        <FRow label={t("cloudSync.port")}>
          <input type="number" value={creds.port} onChange={(e) => f("port")(parseInt(e.target.value) || 22)}
            className="bg-transparent outline-none rounded px-1.5 py-0.5" style={{ border: "1px solid var(--kf-border)", width: 70 }} />
        </FRow>
        <FRow label={t("cloudSync.username")}><TxtField value={creds.username} onChange={(v) => f("username")(v)} /></FRow>
      </div>
      <FRow label={t("cloudSync.password")}><TxtField type="password" value={creds.password} onChange={(v) => f("password")(v)} /></FRow>
      <FRow label={t("cloudSync.remotePath")}><TxtField value={creds.remotePath} onChange={(v) => f("remotePath")(v)} placeholder="/home/user/sync" /></FRow>
    </>
  );
}

function WebdavFields({ creds, onChange }: { creds: NonNullable<CloudSyncJob["webdav"]>; onChange: (v: NonNullable<CloudSyncJob["webdav"]>) => void }) {
  const { t } = useTranslation();
  const f = (k: keyof typeof creds) => (v: string) => onChange({ ...creds, [k]: v });
  return (
    <>
      <FRow label={t("cloudSync.url")}><TxtField value={creds.url} onChange={f("url")} placeholder="https://cloud.example.com/dav/sync/" /></FRow>
      <FRow label={t("cloudSync.username")}><TxtField value={creds.username} onChange={f("username")} /></FRow>
      <FRow label={t("cloudSync.password")}><TxtField type="password" value={creds.password} onChange={f("password")} /></FRow>
    </>
  );
}

// ── OAuth プロバイダ（box/dropbox/gcs/gdrive/onedrive）のフィールド ───────
function OauthFields({ job, onChange, onConnect, onCancelConnect, loading }: {
  job: CloudSyncJob;
  onChange: (p: Partial<CloudSyncJob>) => void;
  onConnect: () => void;
  onCancelConnect: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const provider = job.provider;
  const creds = ((job as unknown as Record<string, Record<string, string> | undefined>)[provider]) ?? {};
  const connected = !!creds.refreshToken;
  const setField = (k: string, v: string) =>
    onChange({ [provider]: { ...creds, [k]: v } } as Partial<CloudSyncJob>);

  return (
    <>
      {/* 接続状態 */}
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 10, color: connected ? "#34d399" : "var(--kf-text-muted)" }}>
          <Icon name={connected ? "check_circle" : "link_off"} size={11} className="inline align-text-bottom mr-1" />
          {connected ? t("cloudSync.connectedStatus") : t("cloudSync.notConnected")}
        </span>
        {/* 未接続時の「接続」はダイアログ内で最重要のアクションなので primary 表示。
            接続済みの「再接続」は控えめなアウトラインに落とす */}
        <button
          onClick={onConnect} disabled={loading}
          className="px-3 py-1 rounded disabled:opacity-40 font-semibold"
          style={
            connected
              ? { border: "1px solid var(--kf-accent)", color: "var(--kf-accent)" }
              : { backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }
          }
        >
          {connected ? t("cloudSync.reconnect") : t("cloudSync.connect")}
        </button>
        {/* 認証待機中はキャンセルで待機を中断し、すぐ再接続できるようにする */}
        {loading && (
          <button
            onClick={onCancelConnect}
            className="px-2 py-0.5 rounded"
            style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)" }}
          >
            {t("common.cancel")}
          </button>
        )}
      </div>

      {/* プロバイダ別の設定 */}
      {provider === "gcs" && (
        <>
          <FRow label={t("cloudSync.bucket")}><TxtField value={creds.bucket ?? ""} onChange={(v) => setField("bucket", v)} placeholder="my-bucket" /></FRow>
          <FRow label={t("cloudSync.prefix")}><TxtField value={creds.prefix ?? ""} onChange={(v) => setField("prefix", v)} placeholder="photos/2026" /></FRow>
        </>
      )}
      {provider === "dropbox" && (
        <FRow label={t("cloudSync.remoteFolder")}><TxtField value={creds.rootPath ?? ""} onChange={(v) => setField("rootPath", v)} placeholder="/Apps/sync" /></FRow>
      )}
      {provider === "box" && (
        <FRow label={t("cloudSync.folderIdZero")}><TxtField value={creds.rootFolderId ?? ""} onChange={(v) => setField("rootFolderId", v)} placeholder="0" /></FRow>
      )}
      {(provider === "gdrive" || provider === "onedrive") && (
        <FRow label={t("cloudSync.folderIdRoot")}><TxtField value={creds.rootFolderId ?? ""} onChange={(v) => setField("rootFolderId", v)} placeholder="root" /></FRow>
      )}
      {provider === "gdrive" && (
        <span style={{ fontSize: 9, color: "var(--kf-text-muted)" }}>
          {t("cloudSync.gdocNote")}
        </span>
      )}
    </>
  );
}
