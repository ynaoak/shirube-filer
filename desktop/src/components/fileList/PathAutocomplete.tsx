import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ReadDirResult } from "../../types/fs";
import Icon from "../common/Icon";

type PathSegment = { label: string; target: string };

// 現在のパスを「クリックでその階層へ移動できる」パンくず用セグメントへ分割する。
// 例: D:\repositories\projects\public → [D, repositories, projects, public]
//   （各ボタンの移動先は D:\ / D:\repositories / … と累積したパス）
function buildPathSegments(path: string): PathSegment[] {
  if (!path) return [];
  const sep = path.includes("\\") ? "\\" : "/";
  const segs: PathSegment[] = [];

  const drive = /^([A-Za-z]:)[\\/]?(.*)$/.exec(path);
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)[\\/]?(.*)$/.exec(path);

  if (drive) {
    let acc = drive[1]; // "D:"
    segs.push({ label: drive[1].replace(/:$/, ""), target: drive[1] + sep }); // ラベル "D" / 移動先 "D:\"
    for (const part of drive[2].split(/[\\/]+/).filter(Boolean)) {
      acc = acc + sep + part;
      segs.push({ label: part, target: acc });
    }
  } else if (unc) {
    let acc = `\\\\${unc[1]}\\${unc[2]}`;
    segs.push({ label: `\\\\${unc[1]}\\${unc[2]}`, target: acc });
    for (const part of unc[3].split(/[\\/]+/).filter(Boolean)) {
      acc = acc + "\\" + part;
      segs.push({ label: part, target: acc });
    }
  } else {
    let acc = "";
    segs.push({ label: "/", target: "/" });
    for (const part of path.split("/").filter(Boolean)) {
      acc = acc + "/" + part;
      segs.push({ label: part, target: acc });
    }
  }
  return segs;
}

// パス入力欄。サブフォルダ名の補完（debounce + 上下キー選択 + Tab 補完）を行う。
// フォーカス時は入力ボックス、非フォーカス時はクリック移動できるパンくず表示。
export default function PathAutocomplete({
  currentPath,
  onNavigate,
  openSignal = 0,
  onDeactivate,
}: {
  currentPath: string;
  onNavigate: (path: string) => void;
  /** 値が変わるたびに入力モードで開く（⌘L から外部の入口を作るため）。 */
  openSignal?: number;
  /** 入力モードを抜けたときの通知（狭いペインでバーを畳み直すのに使う）。 */
  onDeactivate?: () => void;
}) {
  const [draft, setDraft] = useState(currentPath);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [active, setActive] = useState(false);
  const typedDraftRef = useRef(currentPath);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft when currentPath changes externally
  useEffect(() => {
    setDraft(currentPath);
    typedDraftRef.current = currentPath;
    setSuggestions([]);
    setSelectedIdx(-1);
  }, [currentPath]);

  // 非フォーカス（パンくず）→ 入力モードへ切り替わったら入力欄へフォーカスする。
  // onDeactivate は「入力モードを抜けたとき」だけ呼ぶ。マウント直後は active=false
  // なので、素直に else で呼ぶと開いた瞬間に閉じてしまう。
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active) inputRef.current?.focus();
    else if (wasActiveRef.current) onDeactivate?.();
    wasActiveRef.current = active;
    // onDeactivate は毎レンダーで identity が変わりうるので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ⌘L / Ctrl+L から開く。バーを畳んでいるときでもパス入力へ到達できるようにする。
  useEffect(() => {
    if (openSignal > 0) setActive(true);
  }, [openSignal]);

  const fetchSuggestions = useCallback(async (input: string) => {
    const lastSep = Math.max(input.lastIndexOf("\\"), input.lastIndexOf("/"));
    if (lastSep < 0) { setSuggestions([]); return; }
    const parentDir = input.slice(0, lastSep + 1);
    const prefix = input.slice(lastSep + 1).toLowerCase();
    try {
      const result = await invoke<ReadDirResult>("read_dir", { path: parentDir.replace(/[\\/]+$/, ""), showHidden: true });
      const dirs = result.entries
        .filter((e) => e.isDir && e.name.toLowerCase().startsWith(prefix))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      setSuggestions(dirs);
      setSelectedIdx(-1);
    } catch {
      setSuggestions([]);
    }
  }, []);

  const scheduleFetch = useCallback((input: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(input), 120);
  }, [fetchSuggestions]);

  const getSep = (input: string) => input.includes("\\") ? "\\" : "/";

  const completeWith = useCallback(async (name: string, base: string) => {
    const sep = getSep(base);
    const lastSep = Math.max(base.lastIndexOf("\\"), base.lastIndexOf("/"));
    const parentDir = base.slice(0, lastSep + 1);
    const completed = parentDir + name + sep;
    setDraft(completed);
    typedDraftRef.current = completed;
    setSuggestions([]);
    setSelectedIdx(-1);
    // Fetch next level suggestions
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(completed), 0);
  }, [fetchSuggestions]);

  const segments = buildPathSegments(currentPath);

  return (
    <div className="flex-1 relative min-w-0">
      <div
        className="flex items-center gap-1 rounded px-2"
        style={{
          backgroundColor: "var(--kf-bg-primary)",
          border: `1px solid ${active ? "var(--kf-accent)" : "var(--kf-border)"}`,
          transition: "border-color 0.15s",
          // パンくず表示と入力欄で内在高さが異なり、フォーカス時に高さが変わって
          // 見えるため、コンテナを固定高にして両モードとも h-full で埋める。
          height: 26,
        }}
        // 非フォーカス時に余白をクリックしたら入力モードへ切り替える（パンくずボタン自身は stopPropagation）
        onClick={!active ? () => setActive(true) : undefined}
      >
        <Icon name="folder_open" size={12} style={{ color: active ? "var(--kf-accent)" : "var(--kf-text-muted)", flexShrink: 0, transition: "color 0.15s" }} />
      {!active && (
        <div className="flex items-center gap-0.5 flex-1 min-w-0 h-full overflow-x-auto overflow-y-hidden">
          {segments.length === 0 ? (
            <span className="text-xs truncate" style={{ color: "var(--kf-text-muted)" }}>{currentPath}</span>
          ) : (
            segments.map((seg, i) => (
              <Fragment key={`${seg.target}-${i}`}>
                {i > 0 && (
                  <Icon name="chevron_right" size={12} style={{ color: "var(--kf-text-muted)", flexShrink: 0 }} />
                )}
                <button
                  className="text-xs px-1 rounded whitespace-nowrap hover:underline shrink-0"
                  style={{ color: "var(--kf-text-secondary)" }}
                  title={seg.target}
                  onClick={(e) => { e.stopPropagation(); onNavigate(seg.target); }}
                >
                  {seg.label}
                </button>
              </Fragment>
            ))
          )}
        </div>
      )}
      <input
        ref={inputRef}
        value={draft}
        className="flex-1 text-xs bg-transparent outline-none min-w-0 h-full"
        style={{ color: "var(--kf-text-primary)", outline: "none", display: active ? undefined : "none" }}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          typedDraftRef.current = v;
          scheduleFetch(v);
        }}
        onFocus={(e) => {
          setActive(true);
          e.currentTarget.select();
          scheduleFetch(e.currentTarget.value);
        }}
        onBlur={() => {
          setActive(false);
          setDraft(currentPath);
          setSuggestions([]);
          setSelectedIdx(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIdx((prev) => {
              const next = Math.min(prev + 1, suggestions.length - 1);
              if (suggestions[next] !== undefined) {
                const lastSep = Math.max(typedDraftRef.current.lastIndexOf("\\"), typedDraftRef.current.lastIndexOf("/"));
                const parentDir = typedDraftRef.current.slice(0, lastSep + 1);
                setDraft(parentDir + suggestions[next]);
              }
              return next;
            });
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIdx((prev) => {
              const next = Math.max(prev - 1, -1);
              if (next === -1) {
                setDraft(typedDraftRef.current);
              } else if (suggestions[next] !== undefined) {
                const lastSep = Math.max(typedDraftRef.current.lastIndexOf("\\"), typedDraftRef.current.lastIndexOf("/"));
                const parentDir = typedDraftRef.current.slice(0, lastSep + 1);
                setDraft(parentDir + suggestions[next]);
              }
              return next;
            });
          } else if (e.key === "Tab") {
            e.preventDefault();
            const target = selectedIdx >= 0 ? suggestions[selectedIdx] : (suggestions.length === 1 ? suggestions[0] : null);
            if (target !== null && target !== undefined) {
              completeWith(target, typedDraftRef.current);
            }
          } else if (e.key === "Enter") {
            const value = draft;
            setSuggestions([]);
            onNavigate(value);
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            setSuggestions([]);
            setDraft(currentPath);
            inputRef.current?.blur();
          }
        }}
      />
      </div>
      {active && suggestions.length > 0 && (
        <div
          className="absolute left-0 top-full z-50 rounded shadow-xl py-1 text-xs min-w-[200px] max-h-48 overflow-y-auto"
          style={{
            backgroundColor: "var(--kf-bg-secondary)",
            border: "1px solid var(--kf-border)",
            color: "var(--kf-text-primary)",
          }}
        >
          {suggestions.map((name, idx) => (
            <div
              key={name}
              className="px-3 py-1 cursor-pointer whitespace-nowrap"
              style={{
                backgroundColor: idx === selectedIdx ? "var(--kf-accent)" : undefined,
                color: idx === selectedIdx ? "var(--kf-accent-fg, #fff)" : undefined,
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                completeWith(name, typedDraftRef.current);
                inputRef.current?.focus();
              }}
            >
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
