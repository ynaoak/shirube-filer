import { useState, useCallback, useEffect } from "react";
import type { OneDriveProfile, OneDriveEntry, FolderItem } from "./types";
import {
  onedriveStartOauthFlow,
  onedriveRefreshAccessToken,
  onedriveListFiles,
  onedriveDownloadFile,
  onedriveUploadFile,
  onedriveDeleteFile,
  onedriveCreateFolder,
  dialogOpen,
  secretSet,
  secretGet,
  secretDelete,
} from "./invoke";

type AddonProps = { paneId?: string; currentPath?: string };

const PROFILES_KEY = "kf-onedrive-profiles";
const TOKENS_KEY   = "kf-onedrive-refresh-tokens";

// ── Icons ─────────────────────────────────────────────────────────────────────

const OneDriveIcon = () => (
  <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M19.5 13.6a8 8 0 0 0-15 2.9A6 6 0 0 0 6 28h20a5 5 0 0 0 1-9.9 8 8 0 0 0-7.5-4.5z" fill="#0078D4"/>
  </svg>
);

const FolderIcon = ({ color }: { color?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={color ?? "currentColor"} aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
  </svg>
);

const FileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/>
  </svg>
);

// ── CSS vars ──────────────────────────────────────────────────────────────────

const css = {
  bg: "var(--kf-bg-primary)", bgSub: "var(--kf-bg-secondary)",
  border: "var(--kf-border)", text: "var(--kf-text-primary)",
  muted: "var(--kf-text-muted)", accent: "var(--kf-accent)",
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

type StoredProfile = Omit<OneDriveProfile, "refreshToken">;

// リフレッシュトークンは OS の資格情報ストア（キーリング）に保存する。
const secretAccount = (id: string) => `onedrive:${id}:refreshToken`;

function loadProfiles(): OneDriveProfile[] {
  try {
    const stored: StoredProfile[] = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "[]");
    // refreshToken はキーリングから別途ハイドレートする（コンポーネントの useEffect 参照）
    return stored.map(p => ({ ...p, refreshToken: "" }));
  } catch { return []; }
}
function saveProfiles(ps: OneDriveProfile[]) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(ps.map(({ refreshToken: _, ...r }) => r)));
}
async function saveRefreshToken(id: string, t: string) {
  try { await secretSet(secretAccount(id), t); } catch { /* キーリング不可な環境では無視 */ }
}
async function clearRefreshToken(id: string) {
  try { await secretDelete(secretAccount(id)); } catch { /* ignore */ }
}
async function getStoredRefreshToken(id: string): Promise<string> {
  try { return (await secretGet(secretAccount(id))) ?? ""; } catch { return ""; }
}
function makeId() { return Math.random().toString(36).slice(2, 10); }
function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${(n / (1 << 30)).toFixed(2)} GB`;
}
function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ja-JP", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
}

const ROOT: FolderItem = { id: "root", name: "OneDrive" };
type Status = "idle" | "loading" | "authing" | "transferring" | "error";

// ── Component ─────────────────────────────────────────────────────────────────

export default function OneDrivePanel({ currentPath }: AddonProps) {
  const [profiles, setProfiles] = useState<OneDriveProfile[]>(loadProfiles);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [sessionTokens, setSessionTokens] = useState<Record<string, string>>({});

  const [activeProfile, setActiveProfile] = useState<OneDriveProfile | null>(null);
  const [folderStack, setFolderStack] = useState<FolderItem[]>([]);
  const [entries, setEntries] = useState<OneDriveEntry[]>([]);
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

  const persist = (ps: OneDriveProfile[]) => { setProfiles(ps); saveProfiles(ps); };

  const openForm = (p?: OneDriveProfile) => {
    setEditId(p?.id ?? null); setFormName(p?.name ?? "");
    setShowForm(true); setMessage("");
  };
  const saveForm = () => {
    if (!formName.trim()) { setMessage("プロファイル名は必須です"); return; }
    if (editId) persist(profiles.map(p => p.id === editId ? { ...p, name: formName.trim() } : p));
    else persist([...profiles, { id: makeId(), name: formName.trim(), refreshToken: "" }]);
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
    setSelected(new Set()); setStatus("idle"); setMessage(""); setShowNewFolder(false);
  };

  const getAccessToken = useCallback(async (p: OneDriveProfile): Promise<string | null> => {
    if (sessionTokens[p.id]) return sessionTokens[p.id];
    const refreshToken = p.refreshToken || await getStoredRefreshToken(p.id);
    if (refreshToken) {
      try {
        const t = await onedriveRefreshAccessToken(refreshToken);
        setSessionTokens(prev => ({ ...prev, [p.id]: t }));
        return t;
      } catch { /* 失効 → OAuth へ */ }
    }
    return null;
  }, [sessionTokens]);

  const startOauth = async (p: OneDriveProfile) => {
    setStatus("authing"); setMessage("ブラウザで Microsoft アカウントを認証してください（最大 5 分）...");
    try {
      const tokens = await onedriveStartOauthFlow();
      setSessionTokens(prev => ({ ...prev, [p.id]: tokens.accessToken }));
      if (tokens.refreshToken) {
        await saveRefreshToken(p.id, tokens.refreshToken);
        setProfiles(prev => prev.map(q => q.id === p.id ? { ...q, refreshToken: tokens.refreshToken! } : q));
      }
      await openFolder(p, tokens.accessToken, ROOT);
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const openFolder = useCallback(async (
    p: OneDriveProfile, token: string, folder: FolderItem, stack?: FolderItem[]
  ) => {
    setStatus("loading"); setMessage("ファイル一覧を取得中...");
    setActiveProfile(p); setSelected(new Set());
    try {
      const result = await onedriveListFiles(token, folder.id);
      setEntries(result); setFolderStack(stack ?? [folder]);
      setStatus("idle"); setMessage("");
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  }, []);

  const connect = async (p: OneDriveProfile) => {
    const t = await getAccessToken(p);
    if (t) await openFolder(p, t, ROOT);
    else await startOauth(p);
  };

  const navigate = (entry: OneDriveEntry) => {
    if (!activeProfile || !entry.isDir) return;
    const t = sessionTokens[activeProfile.id];
    if (!t) { setStatus("error"); setMessage("接続が切れました。"); return; }
    const folder: FolderItem = { id: entry.id, name: entry.name };
    openFolder(activeProfile, t, folder, [...folderStack, folder]);
  };

  const navigateUp = () => {
    if (!activeProfile) return;
    if (folderStack.length <= 1) { reset(); return; }
    const stack = folderStack.slice(0, -1);
    const t = sessionTokens[activeProfile.id];
    if (!t) return;
    openFolder(activeProfile, t, stack[stack.length - 1], stack);
  };

  const navigateTo = (i: number) => {
    if (!activeProfile) return;
    const stack = folderStack.slice(0, i + 1);
    const t = sessionTokens[activeProfile.id];
    if (!t) return;
    openFolder(activeProfile, t, stack[stack.length - 1], stack);
  };

  const refresh = () => {
    if (!activeProfile || !currentFolder) return;
    const t = sessionTokens[activeProfile.id];
    if (!t) return;
    openFolder(activeProfile, t, currentFolder, folderStack);
  };

  const toggleSelect = (id: string) =>
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const download = async () => {
    if (!activeProfile || selected.size === 0) return;
    const t = sessionTokens[activeProfile.id];
    if (!t) { setStatus("error"); setMessage("接続が切れました。"); return; }
    const files = entries.filter(e => selected.has(e.id) && !e.isDir);
    setStatus("transferring"); setMessage(`ダウンロード中... (0/${files.length})`);
    let done = 0;
    try {
      for (const e of files) {
        await onedriveDownloadFile(t, e.id, e.name, currentPath ?? ".");
        setMessage(`ダウンロード中... (${++done}/${files.length})`);
      }
      setMessage(`${done} 件ダウンロード完了`);
      setStatus("idle"); setSelected(new Set());
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const upload = async () => {
    if (!activeProfile || !currentFolder) return;
    const t = sessionTokens[activeProfile.id];
    if (!t) { setStatus("error"); setMessage("接続が切れました。"); return; }
    const p = await dialogOpen({ title: "アップロードするファイルを選択" });
    if (!p) return;
    setStatus("transferring"); setMessage("アップロード中...");
    try {
      await onedriveUploadFile(t, currentFolder.id, p);
      setMessage("アップロード完了"); setStatus("idle"); refresh();
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const deleteSelected = async () => {
    if (!activeProfile || selected.size === 0) return;
    const t = sessionTokens[activeProfile.id];
    if (!t) { setStatus("error"); setMessage("接続が切れました。"); return; }
    setStatus("transferring"); setMessage(`削除中... (0/${selected.size})`);
    let done = 0;
    try {
      for (const id of selected) {
        await onedriveDeleteFile(t, id);
        setMessage(`削除中... (${++done}/${selected.size})`);
      }
      setMessage(`${done} 件を削除しました`); setStatus("idle"); setSelected(new Set()); refresh();
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const createFolder = async () => {
    if (!activeProfile || !currentFolder || !newFolderName.trim()) return;
    const t = sessionTokens[activeProfile.id];
    if (!t) { setStatus("error"); setMessage("接続が切れました。"); return; }
    setStatus("transferring"); setMessage("フォルダを作成中...");
    try {
      await onedriveCreateFolder(t, currentFolder.id, newFolderName.trim());
      setNewFolderName(""); setShowNewFolder(false);
      setMessage("フォルダを作成しました"); setStatus("idle"); refresh();
    } catch (e) { setStatus("error"); setMessage(String(e)); }
  };

  const btn = (v: "primary"|"secondary"|"danger"|"ms", d=false): React.CSSProperties => ({
    padding: "4px 10px", borderRadius: "4px", border: `1px solid ${css.border}`,
    backgroundColor: v==="primary"?css.accent: v==="danger"?"transparent": v==="ms"?"#0078D4": css.bgSub,
    color: v==="danger"?"#ef4444": v==="primary"||v==="ms"?"#fff": css.text,
    cursor: d?"not-allowed":"pointer", fontSize:"12px", opacity: d?.5:1,
  });
  const inputStyle: React.CSSProperties = {
    padding:"4px 8px", borderRadius:"4px", border:`1px solid ${css.border}`,
    backgroundColor:css.bgSub, color:css.text, fontSize:"12px",
    outline:"none", width:"100%", boxSizing:"border-box",
  };
  const busy = status==="loading"||status==="authing"||status==="transferring";

  return (
    <div style={{ fontFamily:"system-ui,sans-serif", fontSize:"13px", backgroundColor:css.bg, color:css.text, height:"100%", display:"flex", flexDirection:"column", boxSizing:"border-box", overflow:"hidden" }}>
      {/* Header */}
      <div style={{ padding:"8px 12px", borderBottom:`1px solid ${css.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:"8px" }}>
          {inFiles && <button onClick={reset} style={{ ...btn("secondary"), padding:"2px 6px", fontSize:"11px" }}>← 戻る</button>}
          <span style={{ fontWeight:600 }}>{inFiles ? activeProfile?.name ?? "OneDrive" : "OneDrive"}</span>
        </div>
        {!inFiles && <button onClick={() => openForm()} style={btn("secondary")}>+ プロファイル追加</button>}
        {inFiles && <button onClick={refresh} disabled={busy} style={{ ...btn("secondary"), padding:"2px 6px" }} title="更新">↺</button>}
      </div>

      <div style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column" }}>
        {/* Form */}
        {showForm && (
          <div style={{ padding:"10px 12px", borderBottom:`1px solid ${css.border}`, backgroundColor:css.bgSub, display:"flex", flexDirection:"column", gap:"8px" }}>
            <div style={{ fontWeight:600, fontSize:"12px" }}>{editId?"プロファイルを編集":"新規プロファイル"}</div>
            <div style={{ display:"flex", flexDirection:"column", gap:"2px" }}>
              <span style={{ color:css.muted, fontSize:"11px" }}>プロファイル名</span>
              <input type="text" value={formName} onChange={e=>setFormName(e.target.value)} placeholder="My OneDrive" style={inputStyle}/>
            </div>
            {message && showForm && <div style={{ color:"#ef4444", fontSize:"11px" }}>{message}</div>}
            <div style={{ display:"flex", gap:"8px" }}>
              <button onClick={saveForm} style={btn("primary")}>保存</button>
              <button onClick={() => { setShowForm(false); setMessage(""); setFormName(""); }} style={btn("secondary")}>キャンセル</button>
            </div>
          </div>
        )}

        {/* Profile list */}
        {!inFiles && !showForm && profiles.length===0 && (
          <div style={{ padding:"24px 12px", textAlign:"center", color:css.muted, fontSize:"12px" }}>プロファイルがありません。<br/>「+ プロファイル追加」から設定してください。</div>
        )}
        {!inFiles && profiles.map(p => (
          <div key={p.id} style={{ display:"flex", alignItems:"center", padding:"8px 12px", borderBottom:`1px solid ${css.border}`, gap:"8px" }}>
            <OneDriveIcon/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:500, fontSize:"12px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name||"（名前なし）"}</div>
              <div style={{ fontSize:"10px", padding:"0 4px", borderRadius:"3px", display:"inline-block", backgroundColor:p.refreshToken?"#22c55e22":"#ef444422", color:p.refreshToken?"#22c55e":"#ef4444" }}>
                {p.refreshToken?"認証済み":"未認証"}
              </div>
            </div>
            {p.refreshToken
              ? <button onClick={() => connect(p)} disabled={busy} style={btn("primary",busy)}>接続</button>
              : <button onClick={() => startOauth(p)} disabled={busy} style={btn("ms",busy)}>Microsoft 認証</button>}
            <button onClick={() => openForm(p)} style={btn("secondary")}>編集</button>
            <button onClick={() => deleteProfile(p.id)} style={btn("danger")}>削除</button>
          </div>
        ))}

        {(status==="authing"||(status==="error"&&!inFiles)) && (
          <div style={{ padding:"8px 12px", borderBottom:`1px solid ${css.border}`, fontSize:"11px", color:status==="error"?"#ef4444":css.accent, backgroundColor:css.bgSub }}>
            {message}{status==="authing"&&<span style={{ marginLeft:"6px" }}>⌛</span>}
          </div>
        )}

        {/* File view */}
        {inFiles && (
          <div style={{ display:"flex", flexDirection:"column", flex:1 }}>
            {/* Breadcrumb */}
            <div style={{ padding:"5px 12px", borderBottom:`1px solid ${css.border}`, backgroundColor:css.bgSub, display:"flex", alignItems:"center", gap:"4px", flexShrink:0, flexWrap:"wrap" }}>
              <button onClick={navigateUp} style={{ ...btn("secondary"), padding:"2px 6px" }}>↑</button>
              {folderStack.map((f, i) => (
                <span key={f.id} style={{ display:"flex", alignItems:"center", gap:"4px" }}>
                  {i>0&&<span style={{ color:css.muted }}>/</span>}
                  <button onClick={() => navigateTo(i)} style={{ background:"none", border:"none", cursor:"pointer", color:i===folderStack.length-1?css.text:css.accent, fontSize:"11px", padding:"0 2px", fontWeight:i===folderStack.length-1?600:400 }}>{f.name}</button>
                </span>
              ))}
            </div>

            {/* Toolbar */}
            <div style={{ padding:"4px 12px", borderBottom:`1px solid ${css.border}`, display:"flex", gap:"6px", flexShrink:0, flexWrap:"wrap" }}>
              <button onClick={download} disabled={selected.size===0||busy} style={btn("primary",selected.size===0||busy)}>↓ ダウンロード {selected.size>0?`(${selected.size})`:""}</button>
              <button onClick={upload} disabled={busy} style={btn("secondary",busy)}>↑ アップロード</button>
              <button onClick={deleteSelected} disabled={selected.size===0||busy} style={btn("danger",selected.size===0||busy)}>削除 {selected.size>0?`(${selected.size})`:""}</button>
              <button onClick={() => setShowNewFolder(v=>!v)} disabled={busy} style={btn("secondary",busy)}>+ フォルダ</button>
            </div>

            {showNewFolder && (
              <div style={{ padding:"4px 12px", borderBottom:`1px solid ${css.border}`, display:"flex", gap:"6px", flexShrink:0 }}>
                <input type="text" value={newFolderName} onChange={e=>setNewFolderName(e.target.value)}
                  onKeyDown={e => { if(e.key==="Enter") createFolder(); if(e.key==="Escape") setShowNewFolder(false); }}
                  placeholder="フォルダ名" style={{ ...inputStyle, width:"auto", flex:1 }} autoFocus/>
                <button onClick={createFolder} disabled={!newFolderName.trim()||busy} style={btn("primary",!newFolderName.trim()||busy)}>作成</button>
                <button onClick={() => { setShowNewFolder(false); setNewFolderName(""); }} style={btn("secondary")}>×</button>
              </div>
            )}

            {message && inFiles && (
              <div style={{ padding:"4px 12px", fontSize:"11px", color:status==="error"?"#ef4444":css.muted, borderBottom:`1px solid ${css.border}`, flexShrink:0 }}>{message}</div>
            )}
            {status==="loading" && <div style={{ padding:"16px", textAlign:"center", color:css.muted, fontSize:"12px" }}>読み込み中...</div>}

            <div style={{ flex:1, overflowY:"auto" }}>
              {entries.map(entry => (
                <div key={entry.id} onClick={() => entry.isDir?navigate(entry):toggleSelect(entry.id)}
                  style={{ display:"flex", alignItems:"center", padding:"4px 12px", gap:"8px", cursor:"pointer", backgroundColor:selected.has(entry.id)?`${css.accent}22`:"transparent", borderBottom:`1px solid ${css.border}`, userSelect:"none" }}
                  onMouseEnter={e => { if(!selected.has(entry.id)) (e.currentTarget as HTMLDivElement).style.backgroundColor=css.bgSub; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor=selected.has(entry.id)?`${css.accent}22`:"transparent"; }}>
                  {!entry.isDir
                    ? <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleSelect(entry.id)} onClick={e=>e.stopPropagation()} style={{ margin:0, cursor:"pointer", flexShrink:0 }}/>
                    : <div style={{ width:"16px", flexShrink:0 }}/>}
                  {entry.isDir ? <FolderIcon color="var(--kf-accent)"/> : <FileIcon/>}
                  <div style={{ flex:1, fontSize:"12px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:entry.isDir?css.accent:css.text }}>{entry.name}</div>
                  {!entry.isDir && <div style={{ fontSize:"11px", color:css.muted, flexShrink:0 }}>{entry.size>0?formatSize(entry.size):"—"}</div>}
                  <div style={{ fontSize:"10px", color:css.muted, flexShrink:0, minWidth:"100px", textAlign:"right" }}>{formatDate(entry.modified)}</div>
                </div>
              ))}
              {entries.length===0&&status!=="loading"&&<div style={{ padding:"16px", textAlign:"center", color:css.muted, fontSize:"12px" }}>ファイルがありません</div>}
            </div>

            <div style={{ padding:"4px 12px", borderTop:`1px solid ${css.border}`, fontSize:"11px", color:css.muted, flexShrink:0, display:"flex", justifyContent:"space-between" }}>
              <span>{entries.length} 件</span>
              <span>ローカル: {currentPath ?? "—"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
