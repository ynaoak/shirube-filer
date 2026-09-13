import { useState, useCallback, useEffect } from "react";
import type { GcsProfile, GcsBucket, GcsEntry } from "./types";
import {
  gcsStartOauthFlow,
  gcsRefreshAccessToken,
  gcsListBuckets,
  gcsListObjects,
  gcsDownloadObject,
  gcsUploadObject,
  gcsDeleteObject,
  dialogOpen,
  secretSet,
  secretGet,
  secretDelete,
} from "./invoke";

type AddonProps = {
  paneId?: string;
  currentPath?: string;
};

// ── Storage keys ─────────────────────────────────────────────────────────────

const PROFILES_KEY = "kf-gcs-profiles";
const TOKENS_KEY = "kf-gcs-refresh-tokens"; // refreshToken per profile id

// ── SVG icons ────────────────────────────────────────────────────────────────

const BucketIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M5 7c0-1.1 3.13-2 7-2s7 .9 7 2v10c0 1.1-3.13 2-7 2s-7-.9-7-2V7z" />
    <ellipse cx="12" cy="7" rx="7" ry="2" />
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

// ── CSS vars shorthand ────────────────────────────────────────────────────────

const css = {
  bg: "var(--kf-bg-primary)",
  bgSub: "var(--kf-bg-secondary)",
  border: "var(--kf-border)",
  text: "var(--kf-text-primary)",
  textSub: "var(--kf-text-secondary)",
  muted: "var(--kf-text-muted)",
  accent: "var(--kf-accent)",
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

type StoredProfile = Omit<GcsProfile, "refreshToken">;

// リフレッシュトークンは OS の資格情報ストア（キーリング）に保存する。
const secretAccount = (profileId: string) => `gcs:${profileId}:refreshToken`;

function loadProfiles(): GcsProfile[] {
  try {
    const stored: StoredProfile[] = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "[]");
    // refreshToken はキーリングから別途ハイドレートする（コンポーネントの useEffect 参照）
    return stored.map(p => ({ ...p, refreshToken: "" }));
  } catch { return []; }
}

function saveProfiles(ps: GcsProfile[]) {
  const stored: StoredProfile[] = ps.map(({ refreshToken: _rt, ...rest }) => rest);
  localStorage.setItem(PROFILES_KEY, JSON.stringify(stored));
}

async function saveRefreshToken(profileId: string, token: string) {
  try { await secretSet(secretAccount(profileId), token); }
  catch { /* キーリング不可な環境では無視 */ }
}

async function clearRefreshToken(profileId: string) {
  try { await secretDelete(secretAccount(profileId)); }
  catch { /* ignore */ }
}

async function getStoredRefreshToken(profileId: string): Promise<string> {
  try { return (await secretGet(secretAccount(profileId))) ?? ""; }
  catch { return ""; }
}

function makeId() { return Math.random().toString(36).slice(2, 10); }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

const EMPTY_FORM: Omit<GcsProfile, "id" | "refreshToken"> = {
  name: "", projectId: "",
};

type View = "profiles" | "buckets" | "objects";
type Status = "idle" | "loading" | "authing" | "transferring" | "error";

// ── Component ─────────────────────────────────────────────────────────────────

export default function GcsPanel({ currentPath }: AddonProps) {
  const [profiles, setProfiles] = useState<GcsProfile[]>(loadProfiles);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<GcsProfile, "id" | "refreshToken">>(EMPTY_FORM);
  // accessToken はセッションメモリのみ
  const [sessionTokens, setSessionTokens] = useState<Record<string, string>>({});

  const [activeProfile, setActiveProfile] = useState<GcsProfile | null>(null);
  const [view, setView] = useState<View>("profiles");
  const [buckets, setBuckets] = useState<GcsBucket[]>([]);
  const [activeBucket, setActiveBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [entries, setEntries] = useState<GcsEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  // 旧バージョンが localStorage に保存したトークンをキーリングへ移行し、
  // 各プロファイルの refreshToken をキーリングから読み出して state を補完する。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const legacy = localStorage.getItem(TOKENS_KEY);
        if (legacy) {
          const m: Record<string, string> = JSON.parse(legacy);
          await Promise.all(
            Object.entries(m).map(([id, t]) => (t ? saveRefreshToken(id, t) : Promise.resolve())),
          );
          localStorage.removeItem(TOKENS_KEY);
        }
      } catch { /* ignore */ }
      const filled = await Promise.all(
        loadProfiles().map(async p => ({ ...p, refreshToken: await getStoredRefreshToken(p.id) })),
      );
      if (!cancelled) setProfiles(filled);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Profile management ────────────────────────────────────────────────────

  const persist = (ps: GcsProfile[]) => { setProfiles(ps); saveProfiles(ps); };

  const openForm = (p?: GcsProfile) => {
    if (p) {
      setEditId(p.id);
      setForm({ name: p.name, projectId: p.projectId });
    } else {
      setEditId(null); setForm(EMPTY_FORM);
    }
    setShowForm(true); setMessage("");
  };

  const saveForm = () => {
    if (!form.projectId) {
      setMessage("プロジェクト ID は必須です");
      return;
    }
    if (editId) {
      persist(profiles.map(p => p.id === editId ? { ...p, ...form } : p));
    } else {
      const savedId = makeId();
      persist([...profiles, { ...form, id: savedId, refreshToken: "" }]);
    }
    setShowForm(false); setMessage("");
  };

  const deleteProfile = (id: string) => {
    persist(profiles.filter(p => p.id !== id));
    setSessionTokens(prev => { const n = { ...prev }; delete n[id]; return n; });
    void clearRefreshToken(id);
    if (activeProfile?.id === id) reset();
  };

  const reset = () => {
    setActiveProfile(null); setView("profiles"); setBuckets([]);
    setActiveBucket(""); setPrefix(""); setEntries([]);
    setSelected(new Set()); setStatus("idle"); setMessage("");
  };

  // ── Get valid access token (refresh if needed) ────────────────────────────

  const getAccessToken = useCallback(async (profile: GcsProfile): Promise<string | null> => {
    if (sessionTokens[profile.id]) return sessionTokens[profile.id];

    const refreshToken = profile.refreshToken || await getStoredRefreshToken(profile.id);
    if (refreshToken) {
      try {
        const newToken = await gcsRefreshAccessToken(refreshToken);
        setSessionTokens(prev => ({ ...prev, [profile.id]: newToken }));
        return newToken;
      } catch {
        // refresh_token が失効している場合は OAuth フローへ
      }
    }
    return null;
  }, [sessionTokens]);

  // ── OAuth flow ────────────────────────────────────────────────────────────

  const startOauth = async (profile: GcsProfile) => {
    setStatus("authing");
    setMessage("ブラウザで Google アカウントを認証してください（最大 5 分）...");
    try {
      const tokens = await gcsStartOauthFlow();
      setSessionTokens(prev => ({ ...prev, [profile.id]: tokens.accessToken }));
      if (tokens.refreshToken) {
        await saveRefreshToken(profile.id, tokens.refreshToken);
        setProfiles(prev =>
          prev.map(p => p.id === profile.id ? { ...p, refreshToken: tokens.refreshToken! } : p)
        );
      }
      await openBuckets({ ...profile, refreshToken: tokens.refreshToken ?? profile.refreshToken }, tokens.accessToken);
    } catch (e) {
      setStatus("error"); setMessage(String(e));
    }
  };

  // ── GCS operations ────────────────────────────────────────────────────────

  const openBuckets = useCallback(async (profile: GcsProfile, accessToken: string) => {
    setStatus("loading"); setMessage("バケット一覧を取得中...");
    setActiveProfile(profile); setSelected(new Set());
    try {
      const result = await gcsListBuckets(accessToken, profile.projectId);
      setBuckets(result); setView("buckets"); setStatus("idle"); setMessage("");
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  }, []);

  const connect = async (p: GcsProfile) => {
    const accessToken = await getAccessToken(p);
    if (accessToken) {
      await openBuckets(p, accessToken);
    } else {
      await startOauth(p);
    }
  };

  const openBucket = useCallback(async (profile: GcsProfile, bucket: string, pref: string) => {
    const accessToken = sessionTokens[profile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。再接続してください。"); return; }
    setStatus("loading"); setMessage("オブジェクト一覧を取得中...");
    setSelected(new Set());
    try {
      const result = await gcsListObjects(accessToken, bucket, pref);
      setEntries(result); setActiveBucket(bucket); setPrefix(pref);
      setView("objects"); setStatus("idle"); setMessage("");
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  }, [sessionTokens]);

  const navigate = (entry: GcsEntry) => {
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
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。再接続してください。"); return; }
    const localDir = currentPath ?? ".";
    setStatus("transferring"); setMessage(`ダウンロード中... (0/${selected.size})`);
    let done = 0;
    try {
      for (const key of selected) {
        await gcsDownloadObject(accessToken, activeBucket, key, localDir);
        done++;
        setMessage(`ダウンロード中... (${done}/${selected.size})`);
      }
      setMessage(`${done} 件ダウンロード完了`);
      setStatus("idle"); setSelected(new Set());
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const upload = async () => {
    if (!activeProfile) return;
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。再接続してください。"); return; }
    const localPath = await dialogOpen({ title: "アップロードするファイルを選択" });
    if (!localPath) return;
    setStatus("transferring"); setMessage("アップロード中...");
    try {
      await gcsUploadObject(accessToken, activeBucket, prefix, localPath);
      setMessage("アップロード完了");
      setStatus("idle");
      await openBucket(activeProfile, activeBucket, prefix);
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const deleteSelected = async () => {
    if (!activeProfile || selected.size === 0) return;
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。再接続してください。"); return; }
    setStatus("transferring"); setMessage(`削除中... (0/${selected.size})`);
    let done = 0;
    try {
      for (const key of selected) {
        await gcsDeleteObject(accessToken, activeBucket, key);
        done++;
        setMessage(`削除中... (${done}/${selected.size})`);
      }
      setMessage(`${done} 件削除完了`);
      setStatus("idle"); setSelected(new Set());
      await openBucket(activeProfile, activeBucket, prefix);
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  // ── Style helpers ─────────────────────────────────────────────────────────

  const btn = (variant: "primary" | "secondary" | "danger" | "google", disabled = false): React.CSSProperties => ({
    padding: "4px 10px", borderRadius: "4px", border: `1px solid ${css.border}`,
    backgroundColor:
      variant === "primary" ? css.accent :
      variant === "danger" ? "transparent" :
      variant === "google" ? "#4285F4" :
      css.bgSub,
    color: variant === "danger" ? "#ef4444" : variant === "primary" || variant === "google" ? "#fff" : css.text,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "12px", opacity: disabled ? 0.5 : 1,
  });

  const inputStyle: React.CSSProperties = {
    padding: "4px 8px", borderRadius: "4px", border: `1px solid ${css.border}`,
    backgroundColor: css.bgSub, color: css.text, fontSize: "12px",
    outline: "none", width: "100%", boxSizing: "border-box",
  };

  const busy = status === "loading" || status === "authing" || status === "transferring";

  // ── Render ────────────────────────────────────────────────────────────────

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
        display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {activeProfile && view !== "profiles" && (
            <button onClick={reset} style={{ ...btn("secondary"), padding: "2px 6px", fontSize: "11px" }}>
              ← 戻る
            </button>
          )}
          <span style={{ fontWeight: 600 }}>
            {view === "profiles" ? "Google Cloud Storage"
              : view === "buckets" ? activeProfile?.name ?? "GCS"
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

        {/* ── プロファイルフォーム ── */}
        {showForm && (
          <div style={{
            padding: "10px 12px", borderBottom: `1px solid ${css.border}`,
            backgroundColor: css.bgSub, display: "flex", flexDirection: "column", gap: "8px",
          }}>
            <div style={{ fontWeight: 600, fontSize: "12px" }}>
              {editId ? "プロファイルを編集" : "新規プロファイル"}
            </div>

            {[
              { label: "プロファイル名", key: "name", placeholder: "My GCS Project", type: "text" },
              { label: "プロジェクト ID", key: "projectId", placeholder: "my-project-id", type: "text" },
            ].map(({ label, key, placeholder, type }) => (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ color: css.muted, fontSize: "11px" }}>{label}</span>
                <input
                  type={type}
                  value={(form as Record<string, unknown>)[key] as string}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  style={inputStyle}
                />
              </div>
            ))}

            {message && showForm && <div style={{ color: "#ef4444", fontSize: "11px" }}>{message}</div>}

            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={saveForm} style={btn("primary")}>保存</button>
              <button onClick={() => { setShowForm(false); setMessage(""); }} style={btn("secondary")}>キャンセル</button>
            </div>
          </div>
        )}

        {/* ── プロファイル一覧 ── */}
        {view === "profiles" && !showForm && profiles.length === 0 && (
          <div style={{ padding: "24px 12px", textAlign: "center", color: css.muted, fontSize: "12px" }}>
            プロファイルがありません。<br />「+ プロファイル追加」から設定してください。
          </div>
        )}

        {view === "profiles" && profiles.map(p => {
          const hasRefreshToken = !!p.refreshToken;
          return (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", padding: "8px 12px",
              borderBottom: `1px solid ${css.border}`, gap: "8px",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.name || "（名前なし）"}
                </div>
                <div style={{ color: css.muted, fontSize: "11px", display: "flex", gap: "6px", alignItems: "center" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.projectId}
                  </span>
                  <span style={{
                    fontSize: "10px", padding: "0 4px", borderRadius: "3px",
                    backgroundColor: hasRefreshToken ? "#22c55e22" : "#ef444422",
                    color: hasRefreshToken ? "#22c55e" : "#ef4444",
                    flexShrink: 0,
                  }}>
                    {hasRefreshToken ? "認証済み" : "未認証"}
                  </span>
                </div>
              </div>

              {hasRefreshToken ? (
                <button onClick={() => connect(p)} disabled={busy} style={btn("primary", busy)}>
                  接続
                </button>
              ) : (
                <button onClick={() => startOauth(p)} disabled={busy} style={btn("google", busy)}>
                  Google 認証
                </button>
              )}
              <button onClick={() => openForm(p)} style={btn("secondary")}>編集</button>
              <button onClick={() => deleteProfile(p.id)} style={btn("danger")}>削除</button>
            </div>
          );
        })}

        {/* ── ステータスバー（認証中・エラー） ── */}
        {(status === "authing" || (status === "error" && view === "profiles")) && (
          <div style={{
            padding: "8px 12px", borderBottom: `1px solid ${css.border}`,
            fontSize: "11px",
            color: status === "error" ? "#ef4444" : css.accent,
            backgroundColor: css.bgSub,
          }}>
            {message}
            {status === "authing" && (
              <span style={{ marginLeft: "6px" }}>⌛</span>
            )}
          </div>
        )}

        {/* ── バケット一覧 ── */}
        {view === "buckets" && (
          <>
            {status === "loading" && (
              <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>読み込み中...</div>
            )}
            {buckets.map(b => (
              <div key={b.name}
                onClick={() => activeProfile && openBucket(activeProfile, b.name, "")}
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
                  {b.location && (
                    <div style={{ fontSize: "11px", color: css.muted }}>{b.location}{b.created ? ` · ${formatDate(b.created)}` : ""}</div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ── オブジェクト一覧 ── */}
        {view === "objects" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            {/* パスバー */}
            <div style={{
              padding: "5px 12px", borderBottom: `1px solid ${css.border}`,
              backgroundColor: css.bgSub, display: "flex", alignItems: "center", gap: "6px", flexShrink: 0,
            }}>
              <button onClick={navigateUp} style={{ ...btn("secondary"), padding: "2px 6px" }}>↑</button>
              <div style={{
                flex: 1, fontSize: "11px", color: css.textSub, fontFamily: "monospace",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                gs://{activeBucket}/{prefix}
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
                  <div style={{ fontSize: "10px", color: css.muted, flexShrink: 0, minWidth: "100px", textAlign: "right" }}>
                    {formatDate(entry.updated)}
                  </div>
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
