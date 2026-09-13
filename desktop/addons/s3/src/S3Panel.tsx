import { useState, useCallback } from "react";
import type { S3Profile, S3Bucket, S3Entry } from "./types";
import { s3ListBuckets, s3ListObjects, s3DownloadObject, s3UploadObject, s3DeleteObject, dialogOpen, secretSet, secretGet, secretDelete } from "./invoke";

type AddonProps = {
  paneId?: string;
  currentPath?: string;
};

const STORAGE_KEY = "kf-s3-profiles";

// ---- SVG icons ----

const BucketIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M5 7c0-1.1 3.13-2 7-2s7 .9 7 2v10c0 1.1-3.13 2-7 2s-7-.9-7-2V7zm0 3.5c0 1.1 3.13 2 7 2s7-.9 7-2M5 14c0 1.1 3.13 2 7 2s7-.9 7-2" />
  </svg>
);

const FolderIcon = ({ color }: { color?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={color ?? "currentColor"} aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
  </svg>
);

const FileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z" />
  </svg>
);

const css = {
  bg: "var(--kf-bg-primary)",
  bgSub: "var(--kf-bg-secondary)",
  bgTer: "var(--kf-bg-tertiary)",
  border: "var(--kf-border)",
  text: "var(--kf-text-primary)",
  textSub: "var(--kf-text-secondary)",
  muted: "var(--kf-text-muted)",
  accent: "var(--kf-accent)",
} as const;

// ---- helpers ----

type StoredProfile = Omit<S3Profile, "secretKey">;

function loadProfiles(): S3Profile[] {
  try {
    const stored: StoredProfile[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return stored.map(p => ({ ...p, secretKey: "" }));
  } catch { return []; }
}
function saveProfiles(ps: S3Profile[]) {
  // secretKey はセキュリティのため localStorage に保存しない
  const stored: StoredProfile[] = ps.map(({ secretKey: _sk, ...rest }) => rest);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}
function makeId() { return Math.random().toString(36).slice(2, 10); }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

const EMPTY_FORM: Omit<S3Profile, "id"> = {
  name: "", accessKey: "", secretKey: "", region: "us-east-1", endpoint: "",
};

const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-southeast-1", "ap-southeast-2", "ap-south-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
  "sa-east-1", "ca-central-1", "me-south-1", "af-south-1",
];

type ServicePreset = {
  label: string;
  endpoint: string;
  region: string;
  namePlaceholder: string;
};

const SERVICE_PRESETS: Record<string, ServicePreset> = {
  aws: {
    label: "Amazon S3",
    endpoint: "",
    region: "ap-northeast-1",
    namePlaceholder: "My AWS S3",
  },
  sakura: {
    label: "さくらのオブジェクトストレージ",
    endpoint: "https://s3.isk01.sakurastorage.jp",
    region: "jp-north-1",
    namePlaceholder: "さくらクラウド",
  },
  backblaze: {
    label: "Backblaze B2",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    namePlaceholder: "Backblaze B2",
  },
  wasabi: {
    label: "Wasabi",
    endpoint: "https://s3.ap-northeast-1.wasabisys.com",
    region: "ap-northeast-1",
    namePlaceholder: "Wasabi",
  },
  r2: {
    label: "Cloudflare R2",
    endpoint: "https://<account-id>.r2.cloudflarestorage.com",
    region: "auto",
    namePlaceholder: "Cloudflare R2",
  },
  minio: {
    label: "MinIO（カスタム）",
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    namePlaceholder: "My MinIO",
  },
};

type View = "profiles" | "buckets" | "objects";
type Status = "idle" | "loading" | "transferring" | "error";

// ---- component ----

export default function S3Panel({ currentPath }: AddonProps) {
  const [profiles, setProfiles] = useState<S3Profile[]>(loadProfiles);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<S3Profile, "id">>(EMPTY_FORM);

  const [activeProfile, setActiveProfile] = useState<S3Profile | null>(null);
  const [view, setView] = useState<View>("profiles");
  const [buckets, setBuckets] = useState<S3Bucket[]>([]);
  const [activeBucket, setActiveBucket] = useState<string>("");
  const [prefix, setPrefix] = useState<string>("");
  const [entries, setEntries] = useState<S3Entry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // ---- profile management ----

  const persist = (ps: S3Profile[]) => { setProfiles(ps); saveProfiles(ps); };

  const [selectedPreset, setSelectedPreset] = useState<string>("aws");

  const openForm = async (p?: S3Profile) => {
    if (p) {
      setEditId(p.id);
      const stored = await secretGet(`s3:${p.id}:secretKey`).catch(() => null);
      setForm({ name: p.name, accessKey: p.accessKey, secretKey: stored ?? "", region: p.region, endpoint: p.endpoint });
      setSelectedPreset("custom");
    } else {
      setEditId(null); setForm(EMPTY_FORM); setSelectedPreset("aws");
    }
    setShowForm(true); setMessage("");
  };

  const applyPreset = (key: string) => {
    setSelectedPreset(key);
    if (key === "custom") return;
    const preset = SERVICE_PRESETS[key];
    if (!preset) return;
    setForm(f => ({
      ...f,
      endpoint: preset.endpoint,
      region: preset.region,
      name: f.name || preset.namePlaceholder,
    }));
  };

  const saveForm = async () => {
    if (!form.accessKey) { setMessage("アクセスキー ID は必須です"); return; }
    let savedId: string;
    if (editId) {
      persist(profiles.map(p => p.id === editId ? { ...form, id: editId } : p));
      savedId = editId;
    } else {
      savedId = makeId();
      persist([...profiles, { ...form, id: savedId }]);
    }
    if (form.secretKey) {
      await secretSet(`s3:${savedId}:secretKey`, form.secretKey).catch(() => {});
    }
    setShowForm(false); setMessage("");
  };

  const deleteProfile = (id: string) => {
    persist(profiles.filter(p => p.id !== id));
    secretDelete(`s3:${id}:secretKey`).catch(() => {});
    if (activeProfile?.id === id) reset();
  };

  const reset = () => {
    setActiveProfile(null); setView("profiles"); setBuckets([]);
    setActiveBucket(""); setPrefix(""); setEntries([]);
    setSelected(new Set()); setStatus("idle"); setMessage("");
  };

  // ---- S3 operations ----

  const connect = async (p: S3Profile) => {
    const secretKey = await secretGet(`s3:${p.id}:secretKey`).catch(() => null) ?? "";
    if (!secretKey) {
      setStatus("error");
      setMessage("シークレットキーが未入力です。「編集」からシークレットキーを入力してください。");
      return;
    }
    const profileWithSecret: S3Profile = { ...p, secretKey };
    setStatus("loading"); setMessage("バケット一覧を取得中...");
    setActiveProfile(profileWithSecret); setSelected(new Set());
    try {
      const result = await s3ListBuckets(profileWithSecret);
      setBuckets(result); setView("buckets"); setStatus("idle"); setMessage("");
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const openBucket = useCallback(async (profile: S3Profile, bucket: string, pref: string) => {
    setStatus("loading"); setMessage("オブジェクト一覧を取得中...");
    setSelected(new Set());
    try {
      const result = await s3ListObjects(profile, bucket, pref);
      setEntries(result); setActiveBucket(bucket); setPrefix(pref);
      setView("objects"); setStatus("idle"); setMessage("");
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  }, []);

  const navigate = (entry: S3Entry) => {
    if (!activeProfile || !entry.isPrefix) return;
    openBucket(activeProfile, activeBucket, entry.key);
  };

  const navigateUp = () => {
    if (!activeProfile) return;
    if (prefix === "") { setView("buckets"); return; }
    const parts = prefix.replace(/\/$/, "").split("/");
    parts.pop();
    openBucket(activeProfile, activeBucket, parts.length ? parts.join("/") + "/" : "");
  };

  const refresh = () => {
    if (!activeProfile) return;
    if (view === "buckets") connect(activeProfile);
    else if (view === "objects") openBucket(activeProfile, activeBucket, prefix);
  };

  const toggleSelect = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const download = async () => {
    if (!activeProfile || selected.size === 0) return;
    const localDir = currentPath ?? ".";
    setStatus("transferring"); setMessage(`ダウンロード中... (0/${selected.size})`);
    let done = 0;
    try {
      for (const key of selected) {
        await s3DownloadObject(activeProfile, activeBucket, key, localDir);
        done++;
        setMessage(`ダウンロード中... (${done}/${selected.size})`);
      }
      setMessage(`${done} 件ダウンロード完了`);
      setStatus("idle"); setSelected(new Set());
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const upload = async () => {
    if (!activeProfile) return;
    const localPath = await dialogOpen({ title: "アップロードするファイルを選択" });
    if (!localPath) return;
    setStatus("transferring"); setMessage("アップロード中...");
    try {
      await s3UploadObject(activeProfile, activeBucket, prefix, localPath);
      setMessage("アップロード完了");
      setStatus("idle");
      await openBucket(activeProfile, activeBucket, prefix);
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const deleteSelected = async () => {
    if (!activeProfile || selected.size === 0) return;
    setStatus("transferring"); setMessage(`削除中... (0/${selected.size})`);
    let done = 0;
    try {
      for (const key of selected) {
        await s3DeleteObject(activeProfile, activeBucket, key);
        done++;
        setMessage(`削除中... (${done}/${selected.size})`);
      }
      setMessage(`${done} 件削除完了`);
      setStatus("idle"); setSelected(new Set());
      await openBucket(activeProfile, activeBucket, prefix);
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const copyKey = (key: string) => {
    const s3Uri = `s3://${activeBucket}/${key}`;
    navigator.clipboard.writeText(s3Uri).catch(() => {});
    setMessage(`コピー済み: ${s3Uri}`);
    setTimeout(() => setMessage(""), 2000);
  };

  // ---- style helpers ----

  const btn = (variant: "primary" | "secondary" | "danger", disabled = false): React.CSSProperties => ({
    padding: "4px 10px", borderRadius: "4px", border: `1px solid ${css.border}`,
    backgroundColor: variant === "primary" ? css.accent : variant === "danger" ? "transparent" : css.bgSub,
    color: variant === "danger" ? "#ef4444" : variant === "primary" ? "#fff" : css.text,
    cursor: disabled ? "not-allowed" : "pointer", fontSize: "12px", opacity: disabled ? 0.5 : 1,
  });

  const inputStyle: React.CSSProperties = {
    padding: "4px 8px", borderRadius: "4px", border: `1px solid ${css.border}`,
    backgroundColor: css.bgSub, color: css.text, fontSize: "12px",
    outline: "none", width: "100%", boxSizing: "border-box",
  };

  const busy = status === "loading" || status === "transferring";

  return (
    <div style={{
      fontFamily: "system-ui, sans-serif", fontSize: "13px",
      backgroundColor: css.bg, color: css.text,
      height: "100%", display: "flex", flexDirection: "column",
      boxSizing: "border-box", overflow: "hidden",
    }}>
      {/* ヘッダー */}
      <div style={{
        padding: "8px 12px", borderBottom: `1px solid ${css.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {activeProfile && view !== "profiles" && (
            <button onClick={reset} style={{ ...btn("secondary"), padding: "2px 6px", fontSize: "11px" }}>
              ← 戻る
            </button>
          )}
          <span style={{ fontWeight: 600 }}>
            {view === "profiles" ? "S3 Browser"
              : view === "buckets" ? activeProfile?.name ?? "S3"
              : activeBucket}
          </span>
        </div>
        {view === "profiles" && (
          <button onClick={() => openForm()} style={btn("secondary")}>+ プロファイル追加</button>
        )}
        {view !== "profiles" && (
          <button onClick={refresh} disabled={busy} style={{ ...btn("secondary"), padding: "2px 6px" }} title="更新">↺</button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>

        {/* ---- プロファイルフォーム ---- */}
        {showForm && (
          <div style={{
            padding: "10px 12px", borderBottom: `1px solid ${css.border}`,
            backgroundColor: css.bgSub, display: "flex", flexDirection: "column", gap: "8px",
          }}>
            <div style={{ fontWeight: 600, fontSize: "12px" }}>
              {editId ? "プロファイルを編集" : "新規プロファイル"}
            </div>

            {!editId && (
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ color: css.muted, fontSize: "11px" }}>サービス</span>
                <select
                  value={selectedPreset}
                  onChange={e => applyPreset(e.target.value)}
                  style={{ ...inputStyle, appearance: "auto" }}
                >
                  {Object.entries(SERVICE_PRESETS).map(([key, p]) => (
                    <option key={key} value={key}>{p.label}</option>
                  ))}
                  <option value="custom">カスタム</option>
                </select>
              </div>
            )}

            {[
              { label: "プロファイル名", key: "name", placeholder: SERVICE_PRESETS[selectedPreset]?.namePlaceholder ?? "My S3" },
              { label: "アクセスキー ID", key: "accessKey", placeholder: "AKIAIOSFODNN7EXAMPLE" },
              { label: "カスタムエンドポイント（AWS S3 は省略可）", key: "endpoint", placeholder: SERVICE_PRESETS[selectedPreset]?.endpoint || "https://s3.example.com" },
            ].map(({ label, key, placeholder }) => (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ color: css.muted, fontSize: "11px" }}>{label}</span>
                <input
                  value={(form as Record<string, unknown>)[key] as string}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  style={inputStyle}
                />
              </div>
            ))}

            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ color: css.muted, fontSize: "11px" }}>シークレットアクセスキー</span>
              <input
                type="password" value={form.secretKey}
                onChange={e => setForm(f => ({ ...f, secretKey: e.target.value }))}
                placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                style={inputStyle}
              />
              <span style={{ color: css.muted, fontSize: "10px" }}>
                OS の資格情報ストア（Keychain / 資格情報マネージャー）に安全に保存されます。
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ color: css.muted, fontSize: "11px" }}>リージョン</span>
              <select
                value={form.region}
                onChange={e => setForm(f => ({ ...f, region: e.target.value }))}
                style={{ ...inputStyle, appearance: "auto" }}
              >
                <option value="jp-north-1">jp-north-1（さくらクラウド）</option>
                {AWS_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                <option value="auto">auto（Cloudflare R2 など）</option>
              </select>
            </div>

            {message && showForm && <div style={{ color: "#ef4444", fontSize: "11px" }}>{message}</div>}

            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={saveForm} style={btn("primary")}>保存</button>
              <button onClick={() => { setShowForm(false); setMessage(""); }} style={btn("secondary")}>キャンセル</button>
            </div>
          </div>
        )}

        {/* ---- プロファイル一覧 ---- */}
        {view === "profiles" && !showForm && profiles.length === 0 && (
          <div style={{ padding: "24px 12px", textAlign: "center", color: css.muted, fontSize: "12px" }}>
            プロファイルがありません。<br />「+ プロファイル追加」から設定してください。
          </div>
        )}

        {view === "profiles" && profiles.map(p => (
          <div key={p.id} style={{
            display: "flex", alignItems: "center", padding: "8px 12px",
            borderBottom: `1px solid ${css.border}`, gap: "8px",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name || "（名前なし）"}
              </div>
              <div style={{ color: css.muted, fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.endpoint
                  ? p.endpoint.replace(/^https?:\/\//, "")
                  : `s3.${p.region}.amazonaws.com`
                } · {p.region}
              </div>
            </div>
            <button onClick={() => connect(p)} disabled={busy} style={btn("primary", busy)}>接続</button>
            <button onClick={() => openForm(p)} style={btn("secondary")}>編集</button>
            <button onClick={() => deleteProfile(p.id)} style={btn("danger")}>削除</button>
          </div>
        ))}

        {/* ---- バケット一覧 ---- */}
        {view === "buckets" && (
          <>
            {status === "loading" && (
              <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>読み込み中...</div>
            )}
            {buckets.map(b => (
              <div key={b.name} onClick={() => activeProfile && openBucket(activeProfile, b.name, "")}
                style={{
                  display: "flex", alignItems: "center", padding: "8px 12px",
                  borderBottom: `1px solid ${css.border}`, cursor: "pointer", gap: "8px",
                }}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.backgroundColor = css.bgSub}
                onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent"}
              >
                <BucketIcon />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "12px", fontWeight: 500 }}>{b.name}</div>
                  {b.created && <div style={{ fontSize: "11px", color: css.muted }}>{formatDate(b.created)}</div>}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ---- オブジェクトブラウザ ---- */}
        {view === "objects" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            {/* パスバー */}
            <div style={{
              padding: "5px 12px", borderBottom: `1px solid ${css.border}`,
              backgroundColor: css.bgSub, display: "flex", alignItems: "center", gap: "6px", flexShrink: 0,
            }}>
              <button onClick={navigateUp} style={{ ...btn("secondary"), padding: "2px 6px" }}>↑</button>
              <div style={{
                flex: 1, fontSize: "11px", color: css.textSub,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace",
              }}>
                s3://{activeBucket}/{prefix}
              </div>
            </div>

            {/* 操作ツールバー */}
            <div style={{
              padding: "4px 12px", borderBottom: `1px solid ${css.border}`,
              display: "flex", gap: "6px", flexShrink: 0, flexWrap: "wrap",
            }}>
              <button onClick={download} disabled={selected.size === 0 || busy} style={btn("primary", selected.size === 0 || busy)}>
                ↓ ダウンロード {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
              <button onClick={upload} disabled={busy} style={btn("secondary", busy)}>↑ アップロード</button>
              <button onClick={deleteSelected} disabled={selected.size === 0 || busy} style={btn("danger", selected.size === 0 || busy)}>
                削除 {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
            </div>

            {/* ステータス */}
            {message && (
              <div style={{
                padding: "4px 12px", fontSize: "11px",
                color: status === "error" ? "#ef4444" : css.muted,
                borderBottom: `1px solid ${css.border}`, flexShrink: 0,
              }}>{message}</div>
            )}

            {status === "loading" && (
              <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>読み込み中...</div>
            )}

            {/* エントリ一覧 */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {entries.map(entry => (
                <div key={entry.key}
                  onClick={() => entry.isPrefix ? navigate(entry) : toggleSelect(entry.key)}
                  style={{
                    display: "flex", alignItems: "center", padding: "4px 12px", gap: "8px",
                    cursor: "pointer",
                    backgroundColor: selected.has(entry.key) ? `${css.accent}22` : "transparent",
                    borderBottom: `1px solid ${css.border}`, userSelect: "none",
                  }}
                  onMouseEnter={e => { if (!selected.has(entry.key)) (e.currentTarget as HTMLDivElement).style.backgroundColor = css.bgSub; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = selected.has(entry.key) ? `${css.accent}22` : "transparent"; }}
                >
                  {!entry.isPrefix ? (
                    <input type="checkbox" checked={selected.has(entry.key)}
                      onChange={() => toggleSelect(entry.key)}
                      onClick={e => e.stopPropagation()}
                      style={{ margin: 0, cursor: "pointer", flexShrink: 0 }}
                    />
                  ) : <div style={{ width: "16px", flexShrink: 0 }} />}

                  {entry.isPrefix
                    ? <FolderIcon color="var(--kf-accent)" />
                    : <FileIcon />}

                  <div style={{
                    flex: 1, fontSize: "12px", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap",
                    color: entry.isPrefix ? css.accent : css.text,
                  }}>
                    {entry.name}
                    {entry.storageClass && entry.storageClass !== "STANDARD" && (
                      <span style={{ marginLeft: "6px", fontSize: "10px", color: css.muted }}>
                        [{entry.storageClass}]
                      </span>
                    )}
                  </div>

                  {!entry.isPrefix && (
                    <div style={{ fontSize: "11px", color: css.muted, flexShrink: 0 }}>
                      {formatSize(entry.size)}
                    </div>
                  )}
                  <div style={{ fontSize: "10px", color: css.muted, flexShrink: 0, minWidth: "90px", textAlign: "right" }}>
                    {formatDate(entry.lastModified)}
                  </div>
                  {!entry.isPrefix && (
                    <button
                      onClick={e => { e.stopPropagation(); copyKey(entry.key); }}
                      title="S3 URI をコピー"
                      style={{ ...btn("secondary"), padding: "1px 5px", fontSize: "10px", flexShrink: 0 }}
                    >
                      URI
                    </button>
                  )}
                </div>
              ))}
              {entries.length === 0 && status !== "loading" && (
                <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>
                  オブジェクトがありません
                </div>
              )}
            </div>

            {/* フッター */}
            <div style={{
              padding: "4px 12px", borderTop: `1px solid ${css.border}`,
              fontSize: "11px", color: css.muted, flexShrink: 0,
              display: "flex", justifyContent: "space-between",
            }}>
              <span>{entries.length} 件</span>
              <span>ローカル: {currentPath ?? "—"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
