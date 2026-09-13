import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import Icon from "../common/Icon";

type Props = {
  pathA: string;
  pathB: string;
  onClose: () => void;
};

type DiffLine =
  | { type: "equal";  lineA: number; lineB: number; text: string }
  | { type: "delete"; lineA: number;                text: string }
  | { type: "insert";               lineB: number; text: string };

const CONTEXT = 3; // lines of context around each hunk
const MAX_LINES = 3000;

/** Line-based LCS diff. Returns edit script as DiffLine[]. */
function computeDiff(a: string[], b: string[]): DiffLine[] {
  const m = Math.min(a.length, MAX_LINES);
  const n = Math.min(b.length, MAX_LINES);

  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      result.push({ type: "equal", lineA: i, lineB: j, text: a[i] });
      i++; j++;
    } else if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) {
      result.push({ type: "delete", lineA: i, text: a[i] });
      i++;
    } else {
      result.push({ type: "insert", lineB: j, text: b[j] });
      j++;
    }
  }
  // Lines beyond MAX_LINES (truncated)
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    result.push({ type: "equal", lineA: m, lineB: n, text: i18n.t("diffViewer.omittedLines", { count: Math.max(a.length, b.length) - MAX_LINES }) });
  }
  return result;
}

/** Group diff into visible hunks with CONTEXT lines around changes. */
function buildHunks(diff: DiffLine[]): DiffLine[][] {
  // Mark indices of changed lines
  const changed = new Set<number>();
  diff.forEach((d, i) => { if (d.type !== "equal") changed.add(i); });

  const visible = new Set<number>();
  changed.forEach((ci) => {
    for (let k = ci - CONTEXT; k <= ci + CONTEXT; k++) {
      if (k >= 0 && k < diff.length) visible.add(k);
    }
  });

  if (visible.size === 0) return []; // fully identical

  const sorted = Array.from(visible).sort((a, b) => a - b);
  const hunks: DiffLine[][] = [];
  let hunk: DiffLine[] = [];
  let prev = -2;
  for (const idx of sorted) {
    if (idx !== prev + 1 && hunk.length > 0) {
      hunks.push(hunk);
      hunk = [];
    }
    hunk.push(diff[idx]);
    prev = idx;
  }
  if (hunk.length > 0) hunks.push(hunk);
  return hunks;
}

export default function DiffViewer({ pathA, pathB, onClose }: Props) {
  const { t } = useTranslation();
  const [textA, setTextA] = useState<string | null>(null);
  const [textB, setTextB] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [staging, setStaging] = useState(false);
  const [staged, setStaged] = useState(false);

  async function handleStage() {
    setStaging(true);
    try {
      const root = await invoke<string>("git_find_root", { path: pathA });
      await invoke("git_stage", { repoPath: root, paths: [pathA] });
      setStaged(true);
    } catch {
      // silently ignore (e.g. not a git repo)
    } finally {
      setStaging(false);
    }
  }

  const nameA = pathA.split(/[\\/]/).pop() ?? pathA;

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      invoke<string>("read_text_file", { path: pathA, maxBytes: 524288 }),
      invoke<string>("read_text_file", { path: pathB, maxBytes: 524288 }),
    ])
      .then(([a, b]) => { setTextA(a); setTextB(b); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [pathA, pathB]);

  const { diff, hunks, stats } = useMemo(() => {
    if (textA === null || textB === null) return { diff: [], hunks: [], stats: { added: 0, removed: 0 } };
    const linesA = textA.split("\n");
    const linesB = textB.split("\n");
    const d = computeDiff(linesA, linesB);
    const h = buildHunks(d);
    const added = d.filter((x) => x.type === "insert").length;
    const removed = d.filter((x) => x.type === "delete").length;
    return { diff: d, hunks: h, stats: { added, removed } };
  }, [textA, textB]);

  const displayLines = showAll ? [diff] : hunks;
  const identical = !loading && !error && stats.added === 0 && stats.removed === 0;

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="kf-anim-scale flex flex-col rounded-lg shadow-xl overflow-hidden"
        style={{
          width: "min(900px, 92vw)",
          height: "min(700px, 88vh)",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-2 border-b shrink-0 font-semibold text-xs"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          <Icon name="difference" size={15} style={{ color: "var(--kf-accent)" }} />
          <span className="flex-1 truncate">{t("diffViewer.title")}: {nameA}</span>
          {!loading && !error && (
            <span className="flex items-center gap-2 text-[11px] font-normal">
              {stats.removed > 0 && (
                <span style={{ color: "#f87171" }}>−{stats.removed}</span>
              )}
              {stats.added > 0 && (
                <span style={{ color: "#4ade80" }}>+{stats.added}</span>
              )}
              {identical && (
                <span style={{ color: "var(--kf-text-muted)" }}>{t("diffViewer.noDiff")}</span>
              )}
            </span>
          )}
          <button
            onClick={handleStage}
            disabled={staging || staged}
            title={staged ? t("diffViewer.staged") : t("diffViewer.stageLeftFile")}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-normal opacity-80 hover:opacity-100 disabled:opacity-40"
            style={{ border: "1px solid var(--kf-border)", color: staged ? "#4ade80" : "var(--kf-text-primary)" }}
          >
            <Icon name={staged ? "check" : staging ? "progress_activity" : "add_box"} size={13} className={staging ? "animate-spin" : undefined} />
            {staged ? t("diffViewer.staged") : t("diffViewer.stage")}
          </button>
          <button aria-label={t("common.close")} onClick={onClose} className="opacity-50 hover:opacity-100 flex items-center">
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* File path bar */}
        <div
          className="grid text-[10px] px-4 py-1 border-b shrink-0"
          style={{
            gridTemplateColumns: "1fr 1fr",
            borderColor: "var(--kf-border)",
            backgroundColor: "var(--kf-bg-secondary)",
            color: "var(--kf-text-muted)",
          }}
        >
          <span className="truncate pr-4">
            <Icon name="arrow_back" size={10} className="inline mr-1" style={{ color: "#f87171" }} />
            {pathA}
          </span>
          <span className="truncate">
            <Icon name="arrow_forward" size={10} className="inline mr-1" style={{ color: "#4ade80" }} />
            {pathB}
          </span>
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-auto font-mono text-[11px] leading-5">
          {loading && (
            <div className="flex items-center justify-center h-full gap-2" style={{ color: "var(--kf-text-muted)" }}>
              <Icon name="progress_activity" size={18} className="animate-spin" />
              {t("diffViewer.loading")}
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 p-4" style={{ color: "#f87171" }}>
              <Icon name="error" size={14} />
              {error}
            </div>
          )}
          {identical && (
            <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: "var(--kf-text-muted)" }}>
              <Icon name="check_circle" size={32} />
              <span>{t("diffViewer.identical")}</span>
            </div>
          )}
          {!loading && !error && !identical && displayLines.map((hunk, hi) => (
            <div key={hi}>
              {/* Hunk separator */}
              <div
                className="px-3 py-0.5 text-[10px] select-none"
                style={{ backgroundColor: "var(--kf-bg-secondary)", color: "var(--kf-text-muted)", borderBottom: "1px solid var(--kf-border-soft)" }}
              >
                @@ hunk {hi + 1} @@
              </div>
              {hunk.map((line, li) => {
                const lineANum = "lineA" in line ? line.lineA + 1 : null;
                const lineBNum = "lineB" in line ? line.lineB + 1 : null;
                const bg =
                  line.type === "insert" ? "rgba(74,222,128,0.1)" :
                  line.type === "delete" ? "rgba(248,113,113,0.1)" : undefined;
                const marker = line.type === "insert" ? "+" : line.type === "delete" ? "−" : " ";
                const markerColor =
                  line.type === "insert" ? "#4ade80" :
                  line.type === "delete" ? "#f87171" : "var(--kf-text-muted)";

                return (
                  <div
                    key={li}
                    className="flex items-start min-w-0"
                    style={{ backgroundColor: bg }}
                  >
                    {/* Line numbers */}
                    <span
                      className="w-10 shrink-0 text-right pr-2 select-none"
                      style={{ color: "var(--kf-text-muted)", borderRight: "1px solid var(--kf-border-soft)" }}
                    >
                      {lineANum ?? ""}
                    </span>
                    <span
                      className="w-10 shrink-0 text-right pr-2 select-none"
                      style={{ color: "var(--kf-text-muted)", borderRight: "1px solid var(--kf-border-soft)" }}
                    >
                      {lineBNum ?? ""}
                    </span>
                    {/* Marker */}
                    <span className="w-5 shrink-0 text-center select-none" style={{ color: markerColor }}>
                      {marker}
                    </span>
                    {/* Line content */}
                    <span className="flex-1 pl-1 whitespace-pre overflow-x-auto" style={{ color: line.type === "equal" ? "var(--kf-text-secondary)" : "var(--kf-text-primary)" }}>
                      {line.text}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        {!loading && !error && !identical && (
          <div
            className="flex items-center justify-between px-4 py-1.5 border-t shrink-0 text-xs"
            style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)", color: "var(--kf-text-muted)" }}
          >
            <span>{showAll ? t("diffViewer.allLines", { count: diff.length }) : t("diffViewer.hunks", { count: hunks.length })}</span>
            <button
              onClick={() => setShowAll((v) => !v)}
              className="flex items-center gap-1 opacity-70 hover:opacity-100"
            >
              <Icon name={showAll ? "compress" : "expand"} size={13} />
              {showAll ? t("diffViewer.showChangesOnly") : t("diffViewer.showAll")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
