import { useState } from "react";
import { runExternalCommand } from "./invoke";

type AddonProps = {
  paneId?: string;
  currentPath?: string;
};

type Mode = "compress" | "extract";
type Format = "7z" | "zip" | "tar";
type Level = "0" | "1" | "3" | "5" | "7" | "9";

const css = {
  bg:       "var(--kf-bg-primary)",
  bgSub:    "var(--kf-bg-secondary)",
  border:   "var(--kf-border)",
  text:     "var(--kf-text-primary)",
  textSub:  "var(--kf-text-secondary)",
  muted:    "var(--kf-text-muted)",
  accent:   "var(--kf-accent)",
} as const;

export default function SevenZipPanel({ currentPath }: AddonProps) {
  const [mode, setMode] = useState<Mode>("compress");
  const [outputPath, setOutputPath] = useState(currentPath ? `${currentPath}/archive.7z` : "");
  const [format, setFormat] = useState<Format>("7z");
  const [level, setLevel] = useState<Level>("5");
  const [password, setPassword] = useState("");
  const [archivePath, setArchivePath] = useState("");
  const [extractTo, setExtractTo] = useState(currentPath ?? "");
  const [bin, setBin] = useState("7z");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [log, setLog] = useState("");

  const run = async () => {
    setStatus("running");
    setLog("");
    try {
      let args: string[];
      let cwd: string | undefined;
      if (mode === "compress") {
        args = ["a", `-t${format}`, `-mx=${level}`];
        if (password) args.push(`-p${password}`);
        args.push(outputPath, "*");
        cwd = currentPath;
      } else {
        args = ["x", archivePath, `-o${extractTo}`, "-y"];
        if (password) args.push(`-p${password}`);
      }
      const result = await runExternalCommand(bin, args, cwd);
      setLog([result.stdout, result.stderr].filter(Boolean).join("\n"));
      setStatus(result.exitCode === 0 ? "done" : "error");
    } catch (e) {
      setLog(String(e));
      setStatus("error");
    }
  };

  const input = (val: string, onChange: (v: string) => void, placeholder?: string) => (
    <input
      value={val}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        padding: "4px 8px",
        borderRadius: "4px",
        border: `1px solid ${css.border}`,
        backgroundColor: css.bgSub,
        color: css.text,
        fontSize: "12px",
        outline: "none",
        width: "100%",
        boxSizing: "border-box" as const,
      }}
    />
  );

  const label = (text: string) => (
    <span style={{ color: css.muted, fontSize: "11px" }}>{text}</span>
  );

  return (
    <div style={{
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      backgroundColor: css.bg,
      color: css.text,
      height: "100%",
      display: "flex",
      flexDirection: "column",
      padding: "12px",
      gap: "10px",
      boxSizing: "border-box",
      overflowY: "auto",
    }}>
      <div style={{ fontWeight: 600, fontSize: "14px" }}>7-Zip</div>

      {/* モード */}
      <div style={{ display: "flex", gap: "8px" }}>
        {(["compress", "extract"] as Mode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: "4px 12px",
            borderRadius: "4px",
            border: `1px solid ${css.border}`,
            backgroundColor: mode === m ? css.accent : css.bgSub,
            color: mode === m ? "#fff" : css.text,
            cursor: "pointer",
            fontSize: "12px",
          }}>
            {m === "compress" ? "圧縮" : "解凍"}
          </button>
        ))}
      </div>

      {/* バイナリ名 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
        {label("7zバイナリ名")}
        {input(bin, setBin, "7z または 7za")}
      </div>

      {mode === "compress" && <>
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          {label("出力ファイルパス")}
          {input(outputPath, setOutputPath, "/path/to/archive.7z")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          {label("フォーマット")}
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)}
            style={{ padding: "4px 8px", borderRadius: "4px", border: `1px solid ${css.border}`, backgroundColor: css.bgSub, color: css.text, fontSize: "12px" }}>
            <option value="7z">7z（最高圧縮率）</option>
            <option value="zip">ZIP（互換性重視）</option>
            <option value="tar">TAR（無圧縮）</option>
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          {label("圧縮レベル")}
          <select value={level} onChange={(e) => setLevel(e.target.value as Level)}
            style={{ padding: "4px 8px", borderRadius: "4px", border: `1px solid ${css.border}`, backgroundColor: css.bgSub, color: css.text, fontSize: "12px" }}>
            <option value="0">コピー（無圧縮）</option>
            <option value="1">最速</option>
            <option value="3">速い</option>
            <option value="5">標準</option>
            <option value="7">最大</option>
            <option value="9">超圧縮</option>
          </select>
        </div>
      </>}

      {mode === "extract" && <>
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          {label("アーカイブファイルパス")}
          {input(archivePath, setArchivePath, "/path/to/archive.7z")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          {label("解凍先ディレクトリ")}
          {input(extractTo, setExtractTo, "/path/to/destination")}
        </div>
      </>}

      <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
        {label("パスワード（省略可）")}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="暗号化する場合のみ入力"
          style={{ padding: "4px 8px", borderRadius: "4px", border: `1px solid ${css.border}`, backgroundColor: css.bgSub, color: css.text, fontSize: "12px", outline: "none", width: "100%", boxSizing: "border-box" }} />
      </div>

      <button onClick={run} disabled={status === "running"} style={{
        padding: "6px 0",
        borderRadius: "4px",
        border: "none",
        backgroundColor: status === "running" ? css.bgSub : css.accent,
        color: "#fff",
        cursor: status === "running" ? "not-allowed" : "pointer",
        fontWeight: 600,
        fontSize: "13px",
      }}>
        {status === "running" ? "実行中..." : mode === "compress" ? "圧縮実行" : "解凍実行"}
      </button>

      {status === "done" && (
        <div style={{ color: "#22c55e", fontSize: "12px", fontWeight: 500 }}>完了しました</div>
      )}

      {log && (
        <pre style={{
          margin: 0, padding: "8px", borderRadius: "4px",
          backgroundColor: css.bgSub,
          border: `1px solid ${status === "error" ? "#ef4444" : css.border}`,
          color: status === "error" ? "#ef4444" : css.textSub,
          fontSize: "11px", overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
          maxHeight: "200px",
        }}>
          {log}
        </pre>
      )}
    </div>
  );
}
