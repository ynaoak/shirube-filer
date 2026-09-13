import { useState, useEffect, useCallback } from "react";
import type { SftpConn, SftpEntry } from "./types";
import { sftpListDir, sftpDownload, sftpUpload, secretSet, secretGet, secretDelete } from "./invoke";

type AddonProps = {
  paneId?: string;
  currentPath?: string;
};

const STORAGE_KEY = "kf-sftp-connections";

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

type StoredConn = Omit<SftpConn, "password">;

function loadConnections(): SftpConn[] {
  try {
    const stored: StoredConn[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return stored.map(c => ({ ...c, password: "" }));
  } catch {
    return [];
  }
}

function saveConnections(conns: SftpConn[]) {
  // password は OS 資格情報ストアに保存するため localStorage には含めない
  const stored: StoredConn[] = conns.map(({ password: _pw, ...rest }) => rest);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const EMPTY_FORM: Omit<SftpConn, "id"> = {
  name: "",
  host: "",
  port: 22,
  user: "",
  password: "",
  remotePath: "/",
};

type Status = "idle" | "connecting" | "browsing" | "transferring" | "error";

export default function SftpPanel({ currentPath }: AddonProps) {
  const [connections, setConnections] = useState<SftpConn[]>(loadConnections);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<SftpConn, "id">>(EMPTY_FORM);

  const [activeConn, setActiveConn] = useState<SftpConn | null>(null);
  const [remotePath, setRemotePath] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  const persistConns = (conns: SftpConn[]) => {
    setConnections(conns);
    saveConnections(conns);
  };

  const openEditForm = async (conn?: SftpConn) => {
    if (conn) {
      setEditId(conn.id);
      const pw = await secretGet(`sftp:${conn.id}:password`).catch(() => null);
      setForm({ name: conn.name, host: conn.host, port: conn.port, user: conn.user, password: pw ?? "", remotePath: conn.remotePath });
    } else {
      setEditId(null);
      setForm(EMPTY_FORM);
    }
    setShowForm(true);
  };

  const saveForm = async () => {
    if (!form.host || !form.user) {
      setMessage("ホストとユーザー名は必須です");
      return;
    }
    let savedId: string;
    if (editId) {
      persistConns(connections.map((c) => (c.id === editId ? { ...form, id: editId } : c)));
      savedId = editId;
    } else {
      savedId = makeId();
      persistConns([...connections, { ...form, id: savedId }]);
    }
    if (form.password) {
      await secretSet(`sftp:${savedId}:password`, form.password).catch(() => {});
    }
    setShowForm(false);
    setMessage("");
  };

  const deleteConn = (id: string) => {
    persistConns(connections.filter((c) => c.id !== id));
    secretDelete(`sftp:${id}:password`).catch(() => {});
    if (activeConn?.id === id) {
      setActiveConn(null);
      setEntries([]);
      setStatus("idle");
    }
  };

  const browse = useCallback(async (conn: SftpConn, path: string) => {
    setStatus("connecting");
    setMessage("接続中...");
    setSelected(new Set());
    try {
      const result = await sftpListDir(
        { host: conn.host, port: conn.port, user: conn.user, password: conn.password },
        path
      );
      setEntries(result);
      setRemotePath(path);
      setActiveConn(conn);
      setStatus("browsing");
      setMessage("");
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  }, []);

  const connect = async (conn: SftpConn) => {
    const password = await secretGet(`sftp:${conn.id}:password`).catch(() => null) ?? "";
    browse({ ...conn, password }, conn.remotePath);
  };

  const navigate = (entry: SftpEntry) => {
    if (!activeConn || !entry.isDir) return;
    browse(activeConn, entry.path);
  };

  const navigateUp = () => {
    if (!activeConn) return;
    const parent = remotePath.replace(/\/[^/]+\/?$/, "") || "/";
    browse(activeConn, parent);
  };

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const download = async () => {
    if (!activeConn || selected.size === 0) return;
    const localDir = currentPath ?? ".";
    setStatus("transferring");
    setMessage("ダウンロード中...");
    try {
      for (const path of selected) {
        await sftpDownload(
          { host: activeConn.host, port: activeConn.port, user: activeConn.user, password: activeConn.password },
          path,
          localDir
        );
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
    if (!activeConn || !currentPath) {
      setMessage("ローカルパスが取得できません");
      return;
    }
    // ファイル選択は currentPath のディレクトリからユーザーが指定する想定
    // ここでは簡易実装としてカレントパスのフォルダを直接アップロード対象にはせず
    // ユーザーに明示的なパス入力を求める
    const localPath = window.prompt("アップロードするローカルファイルのフルパスを入力してください:");
    if (!localPath) return;
    setStatus("transferring");
    setMessage("アップロード中...");
    try {
      await sftpUpload(
        { host: activeConn.host, port: activeConn.port, user: activeConn.user, password: activeConn.password },
        localPath,
        remotePath
      );
      setMessage("アップロード完了");
      setStatus("browsing");
      await browse(activeConn, remotePath);
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  };

  const refresh = () => {
    if (activeConn) browse(activeConn, remotePath);
  };

  // ---- styles helpers ----
  const btn = (variant: "primary" | "secondary" | "danger", disabled = false) => ({
    padding: "4px 10px",
    borderRadius: "4px",
    border: `1px solid ${css.border}`,
    backgroundColor: variant === "primary" ? css.accent : variant === "danger" ? "transparent" : css.bgSub,
    color: variant === "danger" ? "#ef4444" : variant === "primary" ? "#fff" : css.text,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "12px",
    opacity: disabled ? 0.5 : 1,
  } as React.CSSProperties);

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

  const labelStyle: React.CSSProperties = {
    color: css.muted,
    fontSize: "11px",
  };

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
        <span>SFTP</span>
        <button onClick={() => openEditForm()} style={btn("secondary")}>+ 接続を追加</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>

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
              { label: "名前", key: "name", placeholder: "My Server" },
              { label: "ホスト", key: "host", placeholder: "example.com" },
              { label: "ユーザー", key: "user", placeholder: "username" },
              { label: "リモートパス", key: "remotePath", placeholder: "/" },
            ].map(({ label, key, placeholder }) => (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={labelStyle}>{label}</span>
                <input
                  value={(form as Record<string, unknown>)[key] as string}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  style={inputStyle}
                />
              </div>
            ))}

            <div style={{ display: "flex", gap: "8px" }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={labelStyle}>パスワード</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="••••••••"
                  style={inputStyle}
                />
              </div>
              <div style={{ width: "60px", display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={labelStyle}>ポート</span>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))}
                  style={{ ...inputStyle, width: "100%" }}
                />
              </div>
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
            接続がありません。「+ 接続を追加」から始めてください。
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
                {conn.name || conn.host}
              </div>
              <div style={{ color: css.muted, fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {conn.user}@{conn.host}:{conn.port}{conn.remotePath}
              </div>
            </div>
            <button onClick={() => connect(conn)} disabled={status === "connecting" || status === "transferring"} style={btn("primary", status === "connecting" || status === "transferring")}>
              接続
            </button>
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
                {remotePath}
              </div>
              <button onClick={refresh} title="更新" style={{ ...btn("secondary"), padding: "2px 6px" }}>↺</button>
            </div>

            {/* 転送ツールバー */}
            <div style={{
              padding: "4px 12px",
              borderBottom: `1px solid ${css.border}`,
              display: "flex",
              gap: "6px",
              flexShrink: 0,
            }}>
              <button
                onClick={download}
                disabled={selected.size === 0 || status === "transferring"}
                style={btn("primary", selected.size === 0 || status === "transferring")}
              >
                ↓ ダウンロード {selected.size > 0 ? `(${selected.size})` : ""}
              </button>
              <button
                onClick={upload}
                disabled={status === "transferring"}
                style={btn("secondary", status === "transferring")}
              >
                ↑ アップロード
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
                <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>
                  接続中...
                </div>
              )}
              {(status === "browsing" || status === "transferring") && entries.map((entry) => (
                <div
                  key={entry.path}
                  onClick={() => entry.isDir ? navigate(entry) : toggleSelect(entry.path)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "4px 12px",
                    gap: "8px",
                    cursor: "pointer",
                    backgroundColor: selected.has(entry.path) ? `${css.accent}22` : "transparent",
                    borderBottom: `1px solid ${css.border}`,
                    userSelect: "none",
                  }}
                  onMouseEnter={(e) => { if (!selected.has(entry.path)) (e.currentTarget as HTMLDivElement).style.backgroundColor = css.bgSub; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = selected.has(entry.path) ? `${css.accent}22` : "transparent"; }}
                >
                  {/* チェックボックス（ファイルのみ） */}
                  {!entry.isDir && (
                    <input
                      type="checkbox"
                      checked={selected.has(entry.path)}
                      onChange={() => toggleSelect(entry.path)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ margin: 0, cursor: "pointer", flexShrink: 0 }}
                    />
                  )}
                  {entry.isDir && <div style={{ width: "16px", flexShrink: 0 }} />}

                  {/* アイコン */}
                  <span style={{ fontSize: "14px", flexShrink: 0 }}>
                    {entry.isDir ? "📁" : "📄"}
                  </span>

                  {/* 名前 */}
                  <div style={{
                    flex: 1,
                    fontSize: "12px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: entry.isDir ? css.accent : css.text,
                  }}>
                    {entry.name}
                  </div>

                  {/* サイズ */}
                  {!entry.isDir && (
                    <div style={{ fontSize: "11px", color: css.muted, flexShrink: 0 }}>
                      {formatSize(entry.size)}
                    </div>
                  )}

                  {/* 更新日 */}
                  <div style={{ fontSize: "10px", color: css.muted, flexShrink: 0, minWidth: "100px", textAlign: "right" }}>
                    {formatDate(entry.modified)}
                  </div>
                </div>
              ))}

              {(status === "browsing" || status === "transferring") && entries.length === 0 && (
                <div style={{ padding: "16px", textAlign: "center", color: css.muted, fontSize: "12px" }}>
                  ディレクトリが空です
                </div>
              )}
            </div>

            {/* フッター */}
            <div style={{
              padding: "4px 12px",
              borderTop: `1px solid ${css.border}`,
              fontSize: "11px",
              color: css.muted,
              flexShrink: 0,
            }}>
              {entries.length} 件 / ローカル: {currentPath ?? "—"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
