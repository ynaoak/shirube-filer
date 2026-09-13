import { useState, useCallback, useEffect } from "react";
import type { GDriveProfile, GDriveEntry, FolderItem } from "./types";
import {
  gdriveStartOauthFlow,
  gdriveRefreshAccessToken,
  gdriveListFiles,
  gdriveDownloadFile,
  gdriveUploadFile,
  gdriveDeleteFile,
  gdriveCreateFolder,
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

const PROFILES_KEY = "kf-gdrive-profiles";
const TOKENS_KEY = "kf-gdrive-refresh-tokens";

// ── SVG icons ────────────────────────────────────────────────────────────────

const DriveIcon = () => (
  <svg width="16" height="16" viewBox="0 0 87.3 78" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0a7.3 7.3 0 003.3 3.3z" fill="#0066da"/>
    <path d="M43.65 25L29.9 1.2a7.2 7.2 0 00-3.3 3.3L.5 69.5a7.3 7.3 0 00-.5 3.35H27.5z" fill="#00ac47"/>
    <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25a7.3 7.3 0 00.5-3.35H59.8l5.85 11.5z" fill="#ea4335"/>
    <path d="M43.65 25L57.4 1.2C56.05.45 54.5 0 52.85 0H34.45c-1.65 0-3.2.45-4.55 1.2z" fill="#00832d"/>
    <path d="M59.8 54.5H27.5L13.75 78h60.3L59.8 54.5z" fill="#2684fc"/>
    <path d="M73.4 4.5c-1.35-.8-2.9-1.2-4.55-1.2H52.85L43.65 25 59.8 54.5h26.95L73.4 4.5z" fill="#ffba00"/>
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

// ── CSS vars ──────────────────────────────────────────────────────────────────

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

type StoredProfile = Omit<GDriveProfile, "refreshToken">;

// リフレッシュトークンは OS の資格情報ストア（キーリング）に保存する。
const secretAccount = (profileId: string) => `gdrive:${profileId}:refreshToken`;

function loadProfiles(): GDriveProfile[] {
  try {
    const stored: StoredProfile[] = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "[]");
    // refreshToken はキーリングから別途ハイドレートする（コンポーネントの useEffect 参照）
    return stored.map(p => ({ ...p, refreshToken: "" }));
  } catch { return []; }
}

function saveProfiles(ps: GDriveProfile[]) {
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

type Status = "idle" | "loading" | "authing" | "transferring" | "error";

// ── Component ─────────────────────────────────────────────────────────────────

export default function GDrivePanel({ currentPath }: AddonProps) {
  const [profiles, setProfiles] = useState<GDriveProfile[]>(loadProfiles);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [sessionTokens, setSessionTokens] = useState<Record<string, string>>({});

  const [activeProfile, setActiveProfile] = useState<GDriveProfile | null>(null);
  const [folderStack, setFolderStack] = useState<FolderItem[]>([]);
  const [entries, setEntries] = useState<GDriveEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);

  const currentFolder = folderStack[folderStack.length - 1] ?? null;
  const inFiles = activeProfile !== null;

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

  const persist = (ps: GDriveProfile[]) => { setProfiles(ps); saveProfiles(ps); };

  const openForm = (p?: GDriveProfile) => {
    setEditId(p?.id ?? null);
    setFormName(p?.name ?? "");
    setShowForm(true); setMessage("");
  };

  const saveForm = () => {
    if (!formName.trim()) { setMessage("プロファイル名は必須です"); return; }
    if (editId) {
      persist(profiles.map(p => p.id === editId ? { ...p, name: formName.trim() } : p));
    } else {
      persist([...profiles, { id: makeId(), name: formName.trim(), refreshToken: "" }]);
    }
    setShowForm(false); setMessage(""); setFormName("");
  };

  const deleteProfile = (id: string) => {
    persist(profiles.filter(p => p.id !== id));
    setSessionTokens(prev => { const n = { ...prev }; delete n[id]; return n; });
    void clearRefreshToken(id);
    if (activeProfile?.id === id) reset();
  };

  const reset = () => {
    setActiveProfile(null); setFolderStack([]); setEntries([]);
    setSelected(new Set()); setStatus("idle"); setMessage("");
    setShowNewFolder(false);
  };

  // ── Token management ──────────────────────────────────────────────────────

  const getAccessToken = useCallback(async (profile: GDriveProfile): Promise<string | null> => {
    if (sessionTokens[profile.id]) return sessionTokens[profile.id];
    const refreshToken = profile.refreshToken || await getStoredRefreshToken(profile.id);
    if (refreshToken) {
      try {
        const newToken = await gdriveRefreshAccessToken(refreshToken);
        setSessionTokens(prev => ({ ...prev, [profile.id]: newToken }));
        return newToken;
      } catch { /* 失効 → OAuth フローへ */ }
    }
    return null;
  }, [sessionTokens]);

  // ── OAuth flow ────────────────────────────────────────────────────────────

  const startOauth = async (profile: GDriveProfile) => {
    setStatus("authing");
    setMessage("ブラウザで Google アカウントを認証してください（最大 5 分）...");
    try {
      const tokens = await gdriveStartOauthFlow();
      setSessionTokens(prev => ({ ...prev, [profile.id]: tokens.accessToken }));
      if (tokens.refreshToken) {
        await saveRefreshToken(profile.id, tokens.refreshToken);
        setProfiles(prev => prev.map(p =>
          p.id === profile.id ? { ...p, refreshToken: tokens.refreshToken! } : p
        ));
      }
      await openFolder(profile, tokens.accessToken, { id: "root", name: "My Drive" });
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  // ── File operations ────────────────────────────────────────────────────────

  const openFolder = useCallback(async (
    profile: GDriveProfile,
    accessToken: string,
    folder: FolderItem,
    newStack?: FolderItem[],
  ) => {
    setStatus("loading"); setMessage("ファイル一覧を取得中...");
    setActiveProfile(profile); setSelected(new Set());
    try {
      const result = await gdriveListFiles(accessToken, folder.id);
      setEntries(result);
      setFolderStack(newStack ?? [folder]);
      setStatus("idle"); setMessage("");
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  }, []);

  const connect = async (p: GDriveProfile) => {
    const accessToken = await getAccessToken(p);
    if (accessToken) {
      await openFolder(p, accessToken, { id: "root", name: "My Drive" });
    } else {
      await startOauth(p);
    }
  };

  const navigate = (entry: GDriveEntry) => {
    if (!activeProfile || !entry.isDir) return;
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。再接続してください。"); return; }
    openFolder(activeProfile, accessToken, { id: entry.id, name: entry.name }, [
      ...folderStack,
      { id: entry.id, name: entry.name },
    ]);
  };

  const navigateUp = () => {
    if (!activeProfile) return;
    if (folderStack.length <= 1) { reset(); return; }
    const newStack = folderStack.slice(0, -1);
    const parent = newStack[newStack.length - 1];
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。"); return; }
    openFolder(activeProfile, accessToken, parent, newStack);
  };

  const navigateTo = (idx: number) => {
    if (!activeProfile) return;
    const newStack = folderStack.slice(0, idx + 1);
    const folder = newStack[newStack.length - 1];
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。"); return; }
    openFolder(activeProfile, accessToken, folder, newStack);
  };

  const refresh = () => {
    if (!activeProfile || !currentFolder) return;
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) return;
    openFolder(activeProfile, accessToken, currentFolder, folderStack);
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const download = async () => {
    if (!activeProfile || selected.size === 0) return;
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。"); return; }
    const localDir = currentPath ?? ".";
    setStatus("transferring"); setMessage(`ダウンロード中... (0/${selected.size})`);
    let done = 0;
    try {
      for (const id of selected) {
        const entry = entries.find(e => e.id === id);
        if (!entry || entry.isDir) continue;
        await gdriveDownloadFile(accessToken, entry.id, entry.name, entry.mimeType ?? "", localDir);
        done++;
        setMessage(`ダウンロード中... (${done}/${selected.size})`);
      }
      setMessage(`${done} 件ダウンロード完了`);
      setStatus("idle"); setSelected(new Set());
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const upload = async () => {
    if (!activeProfile || !currentFolder) return;
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。"); return; }
    const localPath = await dialogOpen({ title: "アップロードするファイルを選択" });
    if (!localPath) return;
    setStatus("transferring"); setMessage("アップロード中...");
    try {
      await gdriveUploadFile(accessToken, currentFolder.id, localPath);
      setMessage("アップロード完了");
      setStatus("idle");
      await refresh();
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const deleteSelected = async () => {
    if (!activeProfile || selected.size === 0) return;
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。"); return; }
    setStatus("transferring"); setMessage(`ゴミ箱へ移動中... (0/${selected.size})`);
    let done = 0;
    try {
      for (const id of selected) {
        await gdriveDeleteFile(accessToken, id);
        done++;
        setMessage(`ゴミ箱へ移動中... (${done}/${selected.size})`);
      }
      setMessage(`${done} 件をゴミ箱へ移動しました`);
      setStatus("idle"); setSelected(new Set());
      await refresh();
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const createFolder = async () => {
    if (!activeProfile || !currentFolder || !newFolderName.trim()) return;
    const accessToken = sessionTokens[activeProfile.id];
    if (!accessToken) { setStatus("error"); setMessage("接続が切れました。"); return; }
    setStatus("transferring"); setMessage("フォルダを作成中...");
    try {
      await gdriveCreateFolder(accessToken, currentFolder.id, newFolderName.trim());
      setNewFolderName(""); setShowNewFolder(false);
      setMessage("フォルダを作成しました");
      setStatus("idle");
      await refresh();
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
          {inFiles && (
            <button onClick={reset} style={{ ...btn("secondary"), padding: "2px 6px", fontSize: "11px" }}>
              ← 戻る
            </button>
          )}
          <span style={{ fontWeight: 600 }}>
            {inFiles ? (activeProfile?.name ?? "Google Drive") : "Google Drive"}
          </span>
        </div>
        {!inFiles && (
          <button onClick={() => openForm()} style={btn("secondary")}>+ プロファイル追加</button>
        )}
        {inFiles && (
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
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ color: css.muted, fontSize: "11px" }}>プロファイル名</span>
              <input
                type="text" value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="My Google Drive"
                style={inputStyle}
              />
            </div>
            {message && showForm && <div style={{ color: "#ef4444", fontSize: "11px" }}>{message}</div>}
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={saveForm} style={btn("primary")}>保存</button>
              <button onClick={() => { setShowForm(false); setMessage(""); setFormName(""); }} style={btn("secondary")}>キャンセル</button>
            </div>
          </div>
        )}

        {/* ── プロファイル一覧 ── */}
        {!inFiles && !showForm && profiles.length === 0 && (
          <div style={{ padding: "24px 12px", textAlign: "center", color: css.muted, fontSize: "12px" }}>
            プロファイルがありません。<br />「+ プロファイル追加」から設定してください。
          </div>
        )}

        {!inFiles && profiles.map(p => {
          const authed = !!p.refreshToken;
          return (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", padding: "8px 12px",
              borderBottom: `1px solid ${css.border}`, gap: "8px",
            }}>
              <DriveIcon />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.name || "（名前なし）"}
                </div>
                <div style={{ fontSize: "10px", padding: "0 4px", borderRadius: "3px", display: "inline-block",
                  backgroundColor: authed ? "#22c55e22" : "#ef444422",
                  color: authed ? "#22c55e" : "#ef4444",
                }}>
                  {authed ? "認証済み" : "未認証"}
                </div>
              </div>
              {authed ? (
                <button onClick={() => connect(p)} disabled={busy} style={btn("primary", busy)}>接続</button>
              ) : (
                <button onClick={() => startOauth(p)} disabled={busy} style={btn("google", busy)}>Google 認証</button>
              )}
              <button onClick={() => openForm(p)} style={btn("secondary")}>編集</button>
              <button onClick={() => deleteProfile(p.id)} style={btn("danger")}>削除</button>
            </div>
          );
        })}

        {/* ── 認証中ステータス ── */}
        {(status === "authing" || (status === "error" && !inFiles)) && (
          <div style={{
            padding: "8px 12px", borderBottom: `1px solid ${css.border}`,
            fontSize: "11px", color: status === "error" ? "#ef4444" : css.accent,
            backgroundColor: css.bgSub,
          }}>
            {message}{status === "authing" && <span style={{ marginLeft: "6px" }}>⌛</span>}
          </div>
        )}

        {/* ── ファイルビュー ── */}
        {inFiles && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            {/* パンくず */}
            <div style={{
              padding: "5px 12px", borderBottom: `1px solid ${css.border}`,
              backgroundColor: css.bgSub, display: "flex", alignItems: "center", gap: "4px", flexShrink: 0,
              flexWrap: "wrap",
            }}>
              <button onClick={navigateUp} style={{ ...btn("secondary"), padding: "2px 6px" }}>↑</button>
              {folderStack.map((f, i) => (
                <span key={f.id} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  {i > 0 && <span style={{ color: css.muted }}>/</span>}
                  <button
                    onClick={() => navigateTo(i)}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      color: i === folderStack.length - 1 ? css.text : css.accent,
                      fontSize: "11px", padding: "0 2px", fontWeight: i === folderStack.length - 1 ? 600 : 400,
                    }}
                  >
                    {f.name}
                  </button>
                </span>
              ))}
            </div>

            {/* ツールバー */}
            <div style={{
              padding: "4px 12px", borderBottom: `1px solid ${css.border}`,
              display: "flex", gap: "6px", flexShrink: 0, flexWrap: "wrap", alignItems: "center",
            }}>
              <button onClick={download} disabled={selected.size === 0 || busy} style={btn("primary", selected.size === 0 || busy)}>
                ↓ ダウンロード {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
              <button onClick={upload} disabled={busy} style={btn("secondary", busy)}>↑ アップロード</button>
              <button onClick={deleteSelected} disabled={selected.size === 0 || busy} style={btn("danger", selected.size === 0 || busy)}>
                ゴミ箱 {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
              <button onClick={() => setShowNewFolder(v => !v)} disabled={busy} style={btn("secondary", busy)}>
                + フォルダ
              </button>
            </div>

            {/* 新規フォルダ入力 */}
            {showNewFolder && (
              <div style={{
                padding: "4px 12px", borderBottom: `1px solid ${css.border}`,
                display: "flex", gap: "6px", flexShrink: 0,
              }}>
                <input
                  type="text" value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
                  placeholder="フォルダ名"
                  style={{ ...inputStyle, width: "auto", flex: 1 }}
                  autoFocus
                />
                <button onClick={createFolder} disabled={!newFolderName.trim() || busy} style={btn("primary", !newFolderName.trim() || busy)}>作成</button>
                <button onClick={() => { setShowNewFolder(false); setNewFolderName(""); }} style={btn("secondary")}>×</button>
              </div>
            )}

            {/* ステータス */}
            {message && inFiles && (
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
                <div key={entry.id}
                  onClick={() => entry.isDir ? navigate(entry) : toggleSelect(entry.id)}
                  style={{
                    display: "flex", alignItems: "center", padding: "4px 12px", gap: "8px",
                    cursor: "pointer",
                    backgroundColor: selected.has(entry.id) ? `${css.accent}22` : "transparent",
                    borderBottom: `1px solid ${css.border}`, userSelect: "none",
                  }}
                  onMouseEnter={e => { if (!selected.has(entry.id)) (e.currentTarget as HTMLDivElement).style.backgroundColor = css.bgSub; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = selected.has(entry.id) ? `${css.accent}22` : "transparent"; }}
                >
                  {!entry.isDir ? (
                    <input type="checkbox" checked={selected.has(entry.id)}
                      onChange={() => toggleSelect(entry.id)}
                      onClick={e => e.stopPropagation()}
                      style={{ margin: 0, cursor: "pointer", flexShrink: 0 }}
                    />
                  ) : <div style={{ width: "16px", flexShrink: 0 }} />}

                  {entry.isDir ? <FolderIcon color="var(--kf-accent)" /> : <FileIcon />}

                  <div style={{
                    flex: 1, fontSize: "12px", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap",
                    color: entry.isDir ? css.accent : css.text,
                  }}>
                    {entry.name}
                    {entry.isGoogleDoc && (
                      <span style={{ marginLeft: "6px", fontSize: "10px", color: css.muted }}>[Google Doc → PDF]</span>
                    )}
                  </div>

                  {!entry.isDir && (
                    <div style={{ fontSize: "11px", color: css.muted, flexShrink: 0 }}>
                      {entry.size > 0 ? formatSize(entry.size) : "—"}
                    </div>
                  )}
                  <div style={{ fontSize: "10px", color: css.muted, flexShrink: 0, minWidth: "100px", textAlign: "right" }}>
                    {formatDate(entry.modified)}
                  </div>
                </div>
              ))}
              {entries.length === 0 && status !== "loading" && (
                <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>
                  ファイルがありません
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
