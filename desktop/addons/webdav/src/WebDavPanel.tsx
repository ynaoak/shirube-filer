import { useState, useCallback } from "react";
import type { WebDavConn, WebDavEntry } from "./types";
import { webdavListDir, webdavDownload, webdavUpload, webdavDelete, webdavMkdir } from "./invoke";

type AddonProps = {
  paneId?: string;
  currentPath?: string;
};

const STORAGE_KEY = "kf-webdav-connections";

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

function loadConnections(): WebDavConn[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); }
  catch { return []; }
}

function saveConnections(conns: WebDavConn[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conns));
}

function makeId() { return Math.random().toString(36).slice(2, 10); }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

const EMPTY_FORM: Omit<WebDavConn, "id"> = {
  name: "", baseUrl: "", username: "", password: "",
};

type Status = "idle" | "connecting" | "browsing" | "transferring" | "error";

export default function WebDavPanel({ currentPath }: AddonProps) {
  const [connections, setConnections] = useState<WebDavConn[]>(loadConnections);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<WebDavConn, "id">>(EMPTY_FORM);

  const [activeConn, setActiveConn] = useState<WebDavConn | null>(null);
  const [currentUrl, setCurrentUrl] = useState("");  // full WebDAV URL of current dir
  const [entries, setEntries] = useState<WebDavEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newDirName, setNewDirName] = useState("");
  const [showNewDir, setShowNewDir] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  const persistConns = (conns: WebDavConn[]) => {
    setConnections(conns);
    saveConnections(conns);
  };

  const openEditForm = (conn?: WebDavConn) => {
    if (conn) {
      setEditId(conn.id);
      setForm({ name: conn.name, baseUrl: conn.baseUrl, username: conn.username, password: conn.password });
    } else {
      setEditId(null);
      setForm(EMPTY_FORM);
    }
    setShowForm(true);
  };

  const saveForm = () => {
    if (!form.baseUrl || !form.username) {
      setMessage("URL とユーザー名は必須です");
      return;
    }
    const baseUrl = form.baseUrl.replace(/\/$/, ""); // trailing slash を除去
    const conn = { ...form, baseUrl, id: editId ?? makeId() };
    if (editId) {
      persistConns(connections.map((c) => c.id === editId ? conn : c));
    } else {
      persistConns([...connections, conn]);
    }
    setShowForm(false);
    setMessage("");
  };

  const deleteConn = (id: string) => {
    persistConns(connections.filter((c) => c.id !== id));
    if (activeConn?.id === id) { setActiveConn(null); setEntries([]); setStatus("idle"); }
  };

  const browse = useCallback(async (conn: WebDavConn, url: string) => {
    setStatus("connecting");
    setMessage("接続中...");
    setSelected(new Set());
    try {
      const result = await webdavListDir(url, conn.username, conn.password);
      setEntries(result);
      setCurrentUrl(url);
      setActiveConn(conn);
      setStatus("browsing");
      setMessage("");
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  }, []);

  const connect = (conn: WebDavConn) => browse(conn, conn.baseUrl);

  const navigate = (entry: WebDavEntry) => {
    if (!activeConn || !entry.isDir) return;
    // Build full URL from href
    const origin = new URL(activeConn.baseUrl).origin;
    const fullUrl = origin + entry.href.replace(/\/$/, "");
    browse(activeConn, fullUrl);
  };

  const navigateUp = () => {
    if (!activeConn) return;
    const url = currentUrl.replace(/\/[^/]+\/?$/, "") || activeConn.baseUrl;
    if (url === currentUrl) return;
    browse(activeConn, url);
  };

  const refresh = () => { if (activeConn) browse(activeConn, currentUrl); };

  const toggleSelect = (href: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href); else next.add(href);
      return next;
    });
  };

  const download = async () => {
    if (!activeConn || selected.size === 0) return;
    const localDir = currentPath ?? ".";
    setStatus("transferring");
    setMessage("ダウンロード中...");
    const origin = new URL(activeConn.baseUrl).origin;
    try {
      for (const href of selected) {
        const entry = entries.find((e) => e.href === href);
        if (!entry) continue;
        const fullUrl = origin + href;
        await webdavDownload(fullUrl, activeConn.username, activeConn.password, localDir, entry.name);
      }
      setMessage(`${selected.size} 件ダウンロード完了`);
      setStatus("browsing");
      setSelected(new Set());
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  };

  const upload = async () => {
    if (!activeConn || !currentPath) { setMessage("ローカルパスが取得できません"); return; }
    const localPath = window.prompt("アップロードするローカルファイルのフルパスを入力してください:");
    if (!localPath) return;
    const filename = localPath.replace(/\\/g, "/").split("/").pop() ?? "file";
    const origin = new URL(activeConn.baseUrl).origin;
    const destHref = currentUrl.replace(origin, "") + "/" + filename;
    const destUrl = origin + destHref;
    setStatus("transferring");
    setMessage("アップロード中...");
    try {
      await webdavUpload(destUrl, activeConn.username, activeConn.password, localPath);
      setMessage("アップロード完了");
      setStatus("browsing");
      await browse(activeConn, currentUrl);
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  };

  const deleteSelected = async () => {
    if (!activeConn || selected.size === 0) return;
    if (!window.confirm(`${selected.size} 件を削除しますか？`)) return;
    const origin = new URL(activeConn.baseUrl).origin;
    setStatus("transferring");
    setMessage("削除中...");
    try {
      for (const href of selected) {
        await webdavDelete(origin + href, activeConn.username, activeConn.password);
      }
      setMessage(`${selected.size} 件削除完了`);
      setStatus("browsing");
      await browse(activeConn, currentUrl);
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  };

  const createDir = async () => {
    if (!activeConn || !newDirName.trim()) return;
    const origin = new URL(activeConn.baseUrl).origin;
    const dirUrl = currentUrl + "/" + encodeURIComponent(newDirName.trim());
    setStatus("transferring");
    try {
      await webdavMkdir(dirUrl, activeConn.username, activeConn.password);
      setNewDirName("");
      setShowNewDir(false);
      await browse(activeConn, currentUrl);
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  };

  // ---- styles ----
  const btn = (variant: "primary" | "secondary" | "danger", disabled = false): React.CSSProperties => ({
    padding: "4px 10px",
    borderRadius: "4px",
    border: `1px solid ${css.border}`,
    backgroundColor: variant === "primary" ? css.accent : variant === "danger" ? "transparent" : css.bgSub,
    color: variant === "danger" ? "#ef4444" : variant === "primary" ? "#fff" : css.text,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "12px",
    opacity: disabled ? 0.5 : 1,
    flexShrink: 0,
  });

  const inputStyle: React.CSSProperties = {
    padding: "4px 8px",
    borderRadius: "4px",
    border: `1px solid ${css.border}`,
    backgroundColor: css.bgSub,
    color: css.text,
    fontSize: "12px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = { color: css.muted, fontSize: "11px" };

  return (
    <div style={{
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      backgroundColor: css.bg,
      color: css.text,
      height: "100%",
      display: "flex",
      flexDirection: "column",
      boxSizing: "border-box",
      overflow: "hidden",
    }}>
      {/* ヘッダー */}
      <div style={{
        padding: "8px 12px",
        borderBottom: `1px solid ${css.border}`,
        fontWeight: 600,
        fontSize: "13px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <span>WebDAV</span>
        <button onClick={() => openEditForm()} style={btn("secondary")}>+ 接続を追加</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>

        {/* 接続フォーム */}
        {showForm && (
          <div style={{
            padding: "10px 12px",
            borderBottom: `1px solid ${css.border}`,
            backgroundColor: css.bgSub,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}>
            <div style={{ fontWeight: 600, fontSize: "12px" }}>
              {editId ? "接続を編集" : "新規接続"}
            </div>

            {[
              { label: "名前", key: "name", placeholder: "My Nextcloud" },
              { label: "WebDAV URL", key: "baseUrl", placeholder: "https://cloud.example.com/remote.php/dav/files/user" },
              { label: "ユーザー名", key: "username", placeholder: "username" },
            ].map(({ label, key, placeholder }) => (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={labelStyle}>{label}</span>
                <input
                  value={(form as Record<string, string>)[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  style={inputStyle}
                />
              </div>
            ))}

            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={labelStyle}>パスワード</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="••••••••"
                style={inputStyle}
              />
            </div>

            {message && showForm && (
              <div style={{ color: "#ef4444", fontSize: "11px" }}>{message}</div>
            )}

            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={saveForm} style={btn("primary")}>保存</button>
              <button onClick={() => { setShowForm(false); setMessage(""); }} style={btn("secondary")}>キャンセル</button>
            </div>
          </div>
        )}

        {/* 接続リスト */}
        {connections.length === 0 && !showForm && (
          <div style={{ padding: "24px 12px", textAlign: "center", color: css.muted, fontSize: "12px" }}>
            接続がありません。「+ 接続を追加」から始めてください。<br />
            <span style={{ fontSize: "11px" }}>Nextcloud / ownCloud / Synology NAS などに対応</span>
          </div>
        )}

        {connections.map((conn) => (
          <div key={conn.id} style={{
            display: "flex",
            alignItems: "center",
            padding: "6px 12px",
            borderBottom: `1px solid ${css.border}`,
            backgroundColor: activeConn?.id === conn.id ? css.bgTer : "transparent",
            gap: "8px",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {conn.name || conn.baseUrl}
              </div>
              <div style={{ color: css.muted, fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {conn.username}@{conn.baseUrl.replace(/^https?:\/\//, "").split("/")[0]}
              </div>
            </div>
            <button onClick={() => connect(conn)} disabled={status === "connecting" || status === "transferring"} style={btn("primary", status === "connecting" || status === "transferring")}>接続</button>
            <button onClick={() => openEditForm(conn)} style={btn("secondary")}>編集</button>
            <button onClick={() => deleteConn(conn.id)} style={btn("danger")}>削除</button>
          </div>
        ))}

        {/* ブラウザ */}
        {activeConn && status !== "idle" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            {/* パス + ツールバー */}
            <div style={{
              padding: "6px 12px",
              borderBottom: `1px solid ${css.border}`,
              backgroundColor: css.bgSub,
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flexShrink: 0,
            }}>
              <button onClick={navigateUp} title="上へ" style={{ ...btn("secondary"), padding: "2px 6px" }}>↑</button>
              <div style={{
                flex: 1,
                fontSize: "11px",
                color: css.textSub,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "monospace",
              }}>
                {currentUrl.replace(/^https?:\/\/[^/]+/, "") || "/"}
              </div>
              <button onClick={() => setShowNewDir((v) => !v)} title="フォルダ作成" style={{ ...btn("secondary"), padding: "2px 6px" }}>+</button>
              <button onClick={refresh} title="更新" style={{ ...btn("secondary"), padding: "2px 6px" }}>↺</button>
            </div>

            {/* 新規フォルダ入力 */}
            {showNewDir && (
              <div style={{ padding: "4px 12px", borderBottom: `1px solid ${css.border}`, display: "flex", gap: "6px" }}>
                <input
                  value={newDirName}
                  onChange={(e) => setNewDirName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") createDir(); if (e.key === "Escape") setShowNewDir(false); }}
                  placeholder="フォルダ名"
                  style={{ ...inputStyle, flex: 1 }}
                  autoFocus
                />
                <button onClick={createDir} disabled={!newDirName.trim()} style={btn("primary", !newDirName.trim())}>作成</button>
              </div>
            )}

            {/* 転送ツールバー */}
            <div style={{ padding: "4px 12px", borderBottom: `1px solid ${css.border}`, display: "flex", gap: "6px", flexShrink: 0 }}>
              <button onClick={download} disabled={selected.size === 0 || status === "transferring"} style={btn("primary", selected.size === 0 || status === "transferring")}>
                ↓ ダウンロード {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
              <button onClick={upload} disabled={status === "transferring"} style={btn("secondary", status === "transferring")}>
                ↑ アップロード
              </button>
              <button onClick={deleteSelected} disabled={selected.size === 0 || status === "transferring"} style={btn("danger", selected.size === 0 || status === "transferring")}>
                削除 {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
            </div>

            {/* ステータス */}
            {message && (
              <div style={{
                padding: "4px 12px",
                fontSize: "11px",
                color: status === "error" ? "#ef4444" : css.muted,
                borderBottom: `1px solid ${css.border}`,
                flexShrink: 0,
              }}>
                {message}
              </div>
            )}

            {/* ファイルリスト */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {status === "connecting" && (
                <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>接続中...</div>
              )}
              {(status === "browsing" || status === "transferring") && entries.map((entry) => (
                <div
                  key={entry.href}
                  onClick={() => entry.isDir ? navigate(entry) : toggleSelect(entry.href)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "4px 12px",
                    gap: "8px",
                    cursor: "pointer",
                    backgroundColor: selected.has(entry.href) ? `${css.accent}22` : "transparent",
                    borderBottom: `1px solid ${css.border}`,
                    userSelect: "none",
                  }}
                  onMouseEnter={(e) => { if (!selected.has(entry.href)) (e.currentTarget as HTMLDivElement).style.backgroundColor = css.bgSub; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = selected.has(entry.href) ? `${css.accent}22` : "transparent"; }}
                >
                  {!entry.isDir ? (
                    <input type="checkbox" checked={selected.has(entry.href)} onChange={() => toggleSelect(entry.href)} onClick={(e) => e.stopPropagation()} style={{ margin: 0, cursor: "pointer", flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: "16px", flexShrink: 0 }} />
                  )}
                  <span style={{ fontSize: "14px", flexShrink: 0 }}>{entry.isDir ? "📁" : "📄"}</span>
                  <div style={{ flex: 1, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: entry.isDir ? css.accent : css.text }}>
                    {entry.name}
                  </div>
                  {!entry.isDir && (
                    <div style={{ fontSize: "11px", color: css.muted, flexShrink: 0 }}>{formatSize(entry.size)}</div>
                  )}
                  <div style={{ fontSize: "10px", color: css.muted, flexShrink: 0, minWidth: "100px", textAlign: "right" }}>
                    {formatDate(entry.modified)}
                  </div>
                </div>
              ))}
              {(status === "browsing" || status === "transferring") && entries.length === 0 && (
                <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>ディレクトリが空です</div>
              )}
            </div>

            {/* フッター */}
            <div style={{ padding: "4px 12px", borderTop: `1px solid ${css.border}`, fontSize: "11px", color: css.muted, flexShrink: 0 }}>
              {entries.length} 件 / ローカル: {currentPath ?? "—"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
