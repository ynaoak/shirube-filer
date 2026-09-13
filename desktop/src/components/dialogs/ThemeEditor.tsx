import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../../hooks/useModal";
import {
  THEMES,
  THEME_VAR_LABELS,
  loadCustomTheme,
  loadUserPresets,
  saveUserPresets,
  UserPreset,
} from "../../store/themeStore";
import { applyTheme } from "../providers/ThemeProvider";
import { useTheme } from "../../store/themeStore";
import Icon from "../common/Icon";

const THEME_VAR_I18N_MAP: Record<string, string> = {
  "--kf-bg-primary":    "theme.bgMain",
  "--kf-bg-secondary":  "theme.bgSub",
  "--kf-bg-tertiary":   "theme.bgTertiary",
  "--kf-border":        "theme.border",
  "--kf-border-soft":   "theme.borderWeak",
  "--kf-text-primary":  "theme.textMain",
  "--kf-text-secondary":"theme.textSub",
  "--kf-text-muted":    "theme.textMuted",
  "--kf-accent":          "theme.accent",
  "--kf-window-title-bg": "theme.titlebarBg",
  "--kf-scrollbar-thumb": "theme.scrollbarThumb",
  "--kf-scrollbar-track": "theme.scrollbarTrack",
};

type Props = {
  onClose: () => void;
  embedded?: boolean;
};

// ── Contrast utilities ─────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  return [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)];
}
function linearize(c: number): number {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}
function luminance([r,g,b]: [number,number,number]): number {
  return 0.2126*linearize(r) + 0.7152*linearize(g) + 0.0722*linearize(b);
}
function contrastRatio(a: string, b: string): number | null {
  const ra = hexToRgb(a); const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const la = luminance(ra); const lb = luminance(rb);
  const hi = Math.max(la,lb); const lo = Math.min(la,lb);
  return (hi + 0.05) / (lo + 0.05);
}

const CONTRAST_PAIRS = [
  { bg: "--kf-bg-primary",   fg: "--kf-text-primary",   labelKey: "theme.contrastBgMainText" },
  { bg: "--kf-bg-secondary", fg: "--kf-text-secondary",  labelKey: "theme.contrastBgSubText" },
  { bg: "--kf-bg-tertiary",  fg: "--kf-text-muted",      labelKey: "theme.contrastBgTertiaryText" },
];

function buildInitialVars(): Record<string, string> {
  // Start from current CSS variables on :root
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const { key } of THEME_VAR_LABELS) {
    vars[key] = computed.getPropertyValue(key).trim() || "#000000";
  }
  return vars;
}

export default function ThemeEditor({ onClose, embedded }: Props) {
  const { t } = useTranslation();
  const { setTheme, themeId } = useTheme();
  const [vars, setVars] = useState<Record<string, string>>(() => {
    const custom = loadCustomTheme();
    return custom?.vars ?? buildInitialVars();
  });
  const [mode, setMode] = useState<"dark" | "light">(() => {
    const custom = loadCustomTheme();
    return custom?.mode ?? "dark";
  });
  const [baseTheme, setBaseTheme] = useState("dark");
  const [presetName, setPresetName] = useState(() => t("theme.myTheme"));
  const [userPresets, setUserPresets] = useState<UserPreset[]>(() => loadUserPresets());

  // プリセットが外部（SettingsModal）から選択されたとき、エディタのvarsを同期する
  useEffect(() => {
    if (themeId === "custom" || themeId === "system") return;
    const theme = THEMES.find((t) => t.id === themeId);
    if (theme) {
      setBaseTheme(themeId);
      setVars({ ...theme.vars });
      setMode(theme.mode);
      return;
    }
    if (themeId.startsWith("user-")) {
      const preset = loadUserPresets().find((p) => p.id === themeId);
      if (preset) {
        setVars({ ...preset.vars });
        setMode(preset.mode);
        setPresetName(preset.name);
      }
    }
  }, [themeId]);

  const handleChange = (key: string, value: string) => {
    const next = { ...vars, [key]: value };
    setVars(next);
    // Live preview
    document.documentElement.style.setProperty(key, value);
  };

  const handleLoadBase = (id: string) => {
    const theme = THEMES.find((t) => t.id === id);
    if (!theme) return;
    setBaseTheme(id);
    setVars({ ...theme.vars });
    setMode(theme.mode);
    // Live preview
    for (const [k, v] of Object.entries(theme.vars)) {
      document.documentElement.style.setProperty(k, v);
    }
  };

  // Contrast checks
  const contrastIssues = CONTRAST_PAIRS.map(({ bg, fg, labelKey }) => {
    const ratio = contrastRatio(vars[bg] ?? "", vars[fg] ?? "");
    const same = vars[bg] === vars[fg];
    return { label: t(labelKey), ratio, same };
  }).filter(({ ratio, same }) => same || (ratio !== null && ratio < 3.0));
  const saveBlocked = contrastIssues.some((i) => i.same);

  const handleSave = () => {
    const name = presetName.trim() || t("theme.myTheme");
    // If editing an existing user preset, overwrite it; otherwise create new
    const presets = loadUserPresets();
    const existingIdx = presets.findIndex((p) => p.id === themeId);
    let newId: string;
    if (existingIdx >= 0) {
      newId = themeId;
      presets[existingIdx] = { id: newId, name, mode, vars };
    } else {
      newId = `user-${Date.now()}`;
      presets.push({ id: newId, name, mode, vars });
    }
    saveUserPresets(presets);
    setUserPresets([...presets]);
    setTheme(newId);
    applyTheme(newId);
    onClose();
  };

  const handleDeletePreset = (id: string) => {
    const presets = loadUserPresets().filter((p) => p.id !== id);
    saveUserPresets(presets);
    setUserPresets(presets);
    if (themeId === id) setTheme("shirube-dark");
  };

  const handleCancel = () => {
    // Restore current theme
    applyTheme(document.documentElement.getAttribute("data-theme") as any ?? "shirube-dark");
    onClose();
  };

  // 単体モーダル時のみフォーカストラップ/Esc/復帰を有効化（embedded は設定内のパネル）。
  const dialogRef = useModal<HTMLDivElement>({
    onClose: handleCancel,
    closeOnEsc: !embedded,
    autoFocus: !embedded,
    restoreFocus: !embedded,
  });

  const inner = (
    <div
      ref={embedded ? undefined : dialogRef}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-label={embedded ? undefined : t("theme.editorTitle", "テーマエディタ")}
      className={embedded ? "flex flex-col text-xs h-full" : "kf-anim-scale rounded-lg shadow-xl flex flex-col text-xs"}
      style={embedded ? { color: "var(--kf-text-primary)" } : {
        width: 420,
        maxHeight: "80vh",
        backgroundColor: "var(--kf-bg-primary)",
        border: "1px solid var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {!embedded && (
        <div
          className="flex items-center justify-between px-4 py-2 border-b font-semibold"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <span>{t("theme.editorTitle")}</span>
          <button aria-label={t("common.close")} onClick={handleCancel} className="opacity-50 hover:opacity-100 flex items-center">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

        {/* Preset name input */}
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          <span style={{ color: "var(--kf-text-muted)" }} className="shrink-0">{t("theme.presetName")}:</span>
          <input
            type="text"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            className="flex-1 rounded px-2 py-1 text-xs outline-none"
            style={{
              backgroundColor: "var(--kf-bg-secondary)",
              border: "1px solid var(--kf-border)",
              color: "var(--kf-text-primary)",
            }}
            placeholder={t("theme.myTheme")}
          />
        </div>

        {/* Saved user presets */}
        {userPresets.length > 0 && (
          <div className="px-4 pb-2 flex items-center gap-1 flex-wrap">
            <span style={{ color: "var(--kf-text-muted)" }} className="shrink-0">{t("theme.savedPresets")}:</span>
            {userPresets.map((p) => (
              <span
                key={p.id}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs"
                style={{
                  backgroundColor: themeId === p.id ? "var(--kf-accent)" : "var(--kf-bg-tertiary)",
                  color: themeId === p.id ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-secondary)",
                  border: "1px solid var(--kf-border)",
                }}
              >
                <button
                  onClick={() => { setTheme(p.id); applyTheme(p.id); }}
                  className="hover:opacity-80"
                >
                  {p.name}
                </button>
                <button
                  onClick={() => handleDeletePreset(p.id)}
                  className="opacity-50 hover:opacity-100 ml-0.5"
                  title={t("theme.deletePreset")}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Base theme selector */}
        <div className="px-4 pt-1 pb-2 flex items-center gap-2">
          <span style={{ color: "var(--kf-text-muted)" }}>{t("theme.baseTheme")}:</span>
          <select
            value={baseTheme}
            onChange={(e) => handleLoadBase(e.target.value)}
            className="flex-1 rounded px-2 py-1 text-xs outline-none"
            style={{
              backgroundColor: "var(--kf-bg-secondary)",
              border: "1px solid var(--kf-border)",
              color: "var(--kf-text-primary)",
            }}
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <span style={{ color: "var(--kf-text-muted)" }}>{t("theme.mode")}:</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "dark" | "light")}
            className="rounded px-2 py-1 text-xs outline-none"
            style={{
              backgroundColor: "var(--kf-bg-secondary)",
              border: "1px solid var(--kf-border)",
              color: "var(--kf-text-primary)",
            }}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>

        {/* Color pickers */}
        <div className="flex-1 overflow-y-auto px-4 pb-3 flex flex-col gap-2">
          {THEME_VAR_LABELS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <label className="w-40 shrink-0" style={{ color: "var(--kf-text-secondary)" }}>
                {THEME_VAR_I18N_MAP[key] ? t(THEME_VAR_I18N_MAP[key]) : label}
              </label>
              <input
                type="color"
                value={vars[key] ?? "#000000"}
                onChange={(e) => handleChange(key, e.target.value)}
                className="w-8 h-6 rounded cursor-pointer border-0 p-0"
                style={{ backgroundColor: "transparent" }}
              />
              <input
                type="text"
                value={vars[key] ?? ""}
                onChange={(e) => handleChange(key, e.target.value)}
                className="flex-1 rounded px-2 py-1 font-mono outline-none"
                style={{
                  backgroundColor: "var(--kf-bg-secondary)",
                  border: "1px solid var(--kf-border)",
                  color: "var(--kf-text-primary)",
                }}
              />
            </div>
          ))}
        </div>

        {/* Contrast warnings */}
        {contrastIssues.length > 0 && (
          <div className="px-4 pb-2 flex flex-col gap-1">
            {contrastIssues.map(({ label, ratio, same }) => (
              <div
                key={label}
                className="flex items-center gap-1.5 text-xs px-2 py-1 rounded"
                style={{
                  backgroundColor: same ? "rgba(239,68,68,0.15)" : "rgba(234,179,8,0.15)",
                  border: `1px solid ${same ? "rgba(239,68,68,0.5)" : "rgba(234,179,8,0.5)"}`,
                  color: same ? "#ef4444" : "#ca8a04",
                }}
              >
                <Icon name={same ? "error" : "warning"} size={12} />
                <span>
                  {same
                    ? t("theme.sameColorWarning")
                    : t("theme.lowContrast", { ratio: ratio?.toFixed(1), label })}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-4 py-2 border-t"
          style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <button
            onClick={handleCancel}
            className="kf-btn kf-btn-secondary"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleSave}
            disabled={saveBlocked}
            className="kf-btn kf-btn-primary font-semibold"
            title={saveBlocked ? t("theme.sameColorWarning") : undefined}
          >
            <Icon name={themeId.startsWith("user-") ? "save" : "add_circle"} size={15} />
            {themeId.startsWith("user-") ? t("theme.updatePreset") : t("theme.addCustomTheme")}
          </button>
        </div>
    </div>
  );

  if (embedded) return inner;
  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleCancel(); }}
    >
      {inner}
    </div>
  );
}
