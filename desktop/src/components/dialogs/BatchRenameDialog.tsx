import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { FileEntry } from "../../types/fs";
import { useModal } from "../../hooks/useModal";
import { useFollowPathChange } from "../../hooks/useFollowPathChange";
import Icon from "../common/Icon";

type Props = {
  entries: FileEntry[];
  onClose: () => void;
  onDone: () => void;
};

type Mode = "replace" | "regex" | "serial";

type RenameItem = { entry: FileEntry; newName: string; error: string | null };

function applyReplace(name: string, find: string, replace: string): string {
  if (!find) return name;
  return name.split(find).join(replace);
}

function applyRegex(name: string, pattern: string, replace: string): string {
  if (!pattern) return name;
  try {
    return name.replace(new RegExp(pattern, "g"), replace);
  } catch {
    return name;
  }
}

function applySerial(name: string, index: number, prefix: string, suffix: string, start: number, step: number, digits: number): string {
  const n = String(start + index * step).padStart(digits, "0");
  const ext = name.includes(".") ? "." + name.split(".").slice(1).join(".") : "";
  const stem = name.includes(".") ? name.split(".")[0] : name;
  return `${prefix}${stem}${suffix}${n}${ext}`;
}

function buildNewNames(entries: FileEntry[], mode: Mode, opts: {
  find: string; replace: string;
  pattern: string; regexReplace: string;
  prefix: string; suffix: string; start: number; step: number; digits: number;
  errorNoChange: string; errorEmptyName: string; errorDuplicate: string;
}): RenameItem[] {
  const names = entries.map((entry, i) => {
    let newName: string;
    if (mode === "replace") newName = applyReplace(entry.name, opts.find, opts.replace);
    else if (mode === "regex") newName = applyRegex(entry.name, opts.pattern, opts.regexReplace);
    else newName = applySerial(entry.name, i, opts.prefix, opts.suffix, opts.start, opts.step, opts.digits);
    return { entry, newName, error: null as string | null };
  });

  // Check for duplicates
  const seen = new Set<string>();
  for (const item of names) {
    if (item.newName === item.entry.name) { item.error = opts.errorNoChange; continue; }
    if (!item.newName.trim()) { item.error = opts.errorEmptyName; continue; }
    if (seen.has(item.newName.toLowerCase())) { item.error = opts.errorDuplicate; continue; }
    seen.add(item.newName.toLowerCase());
  }
  return names;
}

export default function BatchRenameDialog({ entries, onClose, onDone }: Props) {
  // リネームにタグ・カラーラベルを追従させる
  const followPathChange = useFollowPathChange();
  const { t } = useTranslation();
  const dialogRef = useModal<HTMLDivElement>({ onClose });
  const [mode, setMode] = useState<Mode>("replace");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [pattern, setPattern] = useState("");
  const [regexReplace, setRegexReplace] = useState("");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [start, setStart] = useState(1);
  const [step, setStep] = useState(1);
  const [digits, setDigits] = useState(3);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errors, setErrors] = useState<{ name: string; err: string }[]>([]);
  const [done, setDone] = useState(false);

  const items = useMemo(() => buildNewNames(entries, mode, {
    find, replace, pattern, regexReplace, prefix, suffix, start, step, digits,
    errorNoChange: t("batchRename.errorNoChange"),
    errorEmptyName: t("batchRename.errorEmptyName"),
    errorDuplicate: t("batchRename.errorDuplicate"),
  }), [entries, mode, find, replace, pattern, regexReplace, prefix, suffix, start, step, digits, t]);

  const validItems = items.filter((item) => !item.error && item.newName !== item.entry.name);

  const regexValid = useMemo(() => {
    if (mode !== "regex" || !pattern) return true;
    try { new RegExp(pattern); return true; } catch { return false; }
  }, [mode, pattern]);

  const execute = async () => {
    if (validItems.length === 0) return;
    setRunning(true);
    setProgress(0);
    setErrors([]);
    const errs: { name: string; err: string }[] = [];
    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      try {
        await invoke("rename_item", { src: item.entry.path, newName: item.newName });
        // タグ・カラーラベルをリネーム先へ付け替える
        const oldPath = item.entry.path;
        const dir = oldPath.replace(/[\\/][^\\/]+$/, "");
        const sep = oldPath.includes("\\") ? "\\" : "/";
        followPathChange(oldPath, `${dir}${sep}${item.newName}`);
      } catch (e) {
        errs.push({ name: item.entry.name, err: String(e) });
      }
      setProgress(i + 1);
    }
    setErrors(errs);
    setRunning(false);
    setDone(true);
    if (errs.length === 0) {
      onDone();
      onClose();
    } else {
      onDone();
    }
  };

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("batchRename.title", "一括リネーム")}
        className="kf-anim-scale flex flex-col rounded-lg shadow-xl text-xs overflow-hidden"
        style={{
          width: 560,
          maxHeight: "85vh",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0 font-semibold"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          <Icon name="drive_file_rename_outline" size={15} style={{ color: "var(--kf-accent)" }} />
          <span className="flex-1">{t("batchRename.header", { count: entries.length })}</span>
          <button aria-label={t("common.close")} onClick={onClose} className="opacity-50 hover:opacity-100 flex items-center">
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* Mode tabs */}
        <div
          className="flex border-b shrink-0"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          {(["replace", "regex", "serial"] as Mode[]).map((m) => {
            const label = m === "replace" ? t("batchRename.modeTextReplace") : m === "regex" ? t("batchRename.modeRegex") : t("batchRename.modeSequential");
            const icon = m === "replace" ? "find_replace" : m === "regex" ? "manage_search" : "format_list_numbered";
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="flex items-center gap-1.5 px-4 py-2 transition-colors"
                style={{
                  borderBottom: mode === m ? "2px solid var(--kf-accent)" : "2px solid transparent",
                  color: mode === m ? "var(--kf-accent)" : "var(--kf-text-muted)",
                }}
              >
                <Icon name={icon} size={13} />
                {label}
              </button>
            );
          })}
        </div>

        {/* Options */}
        <div className="px-4 py-3 border-b shrink-0 space-y-2" style={{ borderColor: "var(--kf-border)" }}>
          {mode === "replace" && (
            <>
              <div className="flex items-center gap-2">
                <label className="w-14 text-right shrink-0" style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelSearch")}</label>
                <input
                  className="flex-1 bg-transparent outline-none px-2 py-1 rounded"
                  style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
                  placeholder={t("batchRename.searchPlaceholder")}
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="w-14 text-right shrink-0" style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelReplace")}</label>
                <input
                  className="flex-1 bg-transparent outline-none px-2 py-1 rounded"
                  style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
                  placeholder={t("batchRename.replacePlaceholder")}
                  value={replace}
                  onChange={(e) => setReplace(e.target.value)}
                />
              </div>
            </>
          )}

          {mode === "regex" && (
            <>
              <div className="flex items-center gap-2">
                <label className="w-14 text-right shrink-0" style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelPattern")}</label>
                <input
                  className="flex-1 bg-transparent outline-none px-2 py-1 rounded font-mono"
                  style={{
                    border: `1px solid ${regexValid ? "var(--kf-border)" : "var(--kf-error)"}`,
                    color: "var(--kf-text-primary)",
                  }}
                  placeholder={t("batchRename.regexPlaceholder")}
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="w-14 text-right shrink-0" style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelReplace")}</label>
                <input
                  className="flex-1 bg-transparent outline-none px-2 py-1 rounded font-mono"
                  style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
                  placeholder={t("batchRename.regexReplacePlaceholder")}
                  value={regexReplace}
                  onChange={(e) => setRegexReplace(e.target.value)}
                />
              </div>
            </>
          )}

          {mode === "serial" && (
            <>
              <div className="flex items-center gap-2">
                <label className="w-14 text-right shrink-0" style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelPrefix")}</label>
                <input
                  className="flex-1 bg-transparent outline-none px-2 py-1 rounded"
                  style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
                  placeholder={t("batchRename.prefixPlaceholder")}
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                />
                <label className="w-14 text-right shrink-0" style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelSuffix")}</label>
                <input
                  className="flex-1 bg-transparent outline-none px-2 py-1 rounded"
                  style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
                  placeholder={t("batchRename.suffixPlaceholder")}
                  value={suffix}
                  onChange={(e) => setSuffix(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-3">
                <label style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelStart")}</label>
                <input type="number" className="w-16 bg-transparent outline-none px-2 py-1 rounded text-center"
                  style={{ border: "1px solid var(--kf-border)" }} value={start} min={0}
                  onChange={(e) => setStart(Number(e.target.value))} />
                <label style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelStep")}</label>
                <input type="number" className="w-16 bg-transparent outline-none px-2 py-1 rounded text-center"
                  style={{ border: "1px solid var(--kf-border)" }} value={step} min={1}
                  onChange={(e) => setStep(Math.max(1, Number(e.target.value)))} />
                <label style={{ color: "var(--kf-text-muted)" }}>{t("batchRename.labelDigits")}</label>
                <input type="number" className="w-16 bg-transparent outline-none px-2 py-1 rounded text-center"
                  style={{ border: "1px solid var(--kf-border)" }} value={digits} min={1} max={10}
                  onChange={(e) => setDigits(Math.max(1, Number(e.target.value)))} />
              </div>
            </>
          )}
        </div>

        {/* Preview table */}
        <div className="flex-1 overflow-y-auto">
          <div
            className="grid text-[10px] px-3 py-1 sticky top-0"
            style={{
              gridTemplateColumns: "1fr 1fr auto",
              backgroundColor: "var(--kf-bg-secondary)",
              borderBottom: "1px solid var(--kf-border)",
              color: "var(--kf-text-muted)",
            }}
          >
            <span>{t("batchRename.colBefore")}</span>
            <span>{t("batchRename.colAfter")}</span>
            <span className="w-16 text-center">{t("batchRename.colStatus")}</span>
          </div>
          {items.map((item) => {
            const unchanged = item.newName === item.entry.name;
            const hasError = !!item.error && item.error !== t("batchRename.errorNoChange");
            return (
              <div
                key={item.entry.path}
                className="grid items-center px-3 py-0.5 border-b"
                style={{
                  gridTemplateColumns: "1fr 1fr auto",
                  borderColor: "var(--kf-border-soft)",
                  backgroundColor: hasError ? "rgba(239,68,68,0.07)" : undefined,
                }}
              >
                <span className="truncate pr-2" style={{ color: "var(--kf-text-muted)", fontFamily: "monospace" }}>
                  {item.entry.name}
                </span>
                <span
                  className="truncate pr-2 font-mono"
                  style={{ color: unchanged ? "var(--kf-text-muted)" : hasError ? "var(--kf-error)" : "var(--kf-accent)" }}
                >
                  {item.newName || "—"}
                </span>
                <span className="w-16 text-center" style={{ color: hasError ? "var(--kf-error)" : "var(--kf-text-muted)" }}>
                  {item.error ?? (unchanged ? "" : "✓")}
                </span>
              </div>
            );
          })}
        </div>

        {/* Error summary after execution */}
        {done && errors.length > 0 && (
          <div className="px-4 py-2 border-t shrink-0" style={{ borderColor: "var(--kf-border)", color: "var(--kf-error)" }}>
            {errors.map((e) => (
              <div key={e.name}>{e.name}: {e.err}</div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-2 border-t shrink-0"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <span style={{ color: "var(--kf-text-muted)" }}>
            {running
              ? t("batchRename.running", { current: progress, total: validItems.length })
              : t("batchRename.changeCount", { count: validItems.length })}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="kf-btn kf-btn-secondary"
            >
              {done ? t("common.close") : t("common.cancel")}
            </button>
            {!done && (
              <button
                onClick={execute}
                disabled={validItems.length === 0 || running || !regexValid}
                className="kf-btn kf-btn-primary"
              >
                <Icon name="drive_file_rename_outline" size={13} />
                {t("batchRename.run", { count: validItems.length })}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
