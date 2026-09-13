import { createContext, useContext } from "react";

export type ColorMode = "dark" | "light";

// Built-in IDs are still valid strings; user preset IDs are "user-<timestamp>"
export type ThemeId = string;

/**
 * 配色に加えて「形状」まで変える UI スタイル。
 * 既定（未指定）は従来の shirube デザイン。"win11" は Windows 11 標準
 * エクスプローラー風（角丸・ゆったりした行・細いスクロールバー）。
 * root の data-ui-style 属性として適用し、App.css 側で形状を上書きする。
 */
export type UiStyle = "win11";

export type ThemeDefinition = {
  id: ThemeId;
  name: string;
  mode: ColorMode;
  vars: Record<string, string>;
  uiStyle?: UiStyle;
};

// White-base template shared by all light themes:
// bg: #FFFFFF / #F7F7F8 / #EEEEEF  border: #DCDCDD / #F0F0F1
// text: #111111 / #444444 / #777777  scrollbar: #D4D4D5 / #F0F0F1
// Only --kf-accent and --kf-window-title-bg differ per theme.

export const THEMES: ThemeDefinition[] = [
  // ── Shirube ──────────────────────────────────────────────────────────────
  {
    id: "shirube-dark",
    name: "Shirube Dark",
    mode: "dark",
    // ニュートラルな近黒のベースに、水色(#7DD3FC) をアクセントとしてのみ使う。
    // テキストは白。背景を青で塗らないことで「青すぎる」状態を避ける。
    vars: {
      "--kf-bg-primary":    "#17191D",
      "--kf-bg-secondary":  "#1E2127",
      "--kf-bg-tertiary":   "#2A2E35",
      "--kf-border":        "#353A42",
      "--kf-border-soft":   "#23272E",
      "--kf-text-primary":  "#F2F4F7",
      "--kf-text-secondary":"#BAC1CB",
      "--kf-text-muted":    "#8E97A1",
      "--kf-accent":           "#7DD3FC",
      "--kf-accent-fg":        "#08334A",
      "--kf-window-title-bg":  "#17191D",
      "--kf-scrollbar-thumb":  "#353A42",
      "--kf-scrollbar-track":  "#1E2127",
    },
  },
  {
    id: "shirube-light",
    name: "Shirube Light",
    mode: "light",
    // 白〜ニュートラルグレーのベースに、近黒テキスト。アクセントは視認性のため
    // やや濃いめの空色(#0284C7)。背景は青く染めずニュートラルに保つ。
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F5F6F8",
      "--kf-bg-tertiary":   "#E9EBEF",
      "--kf-border":        "#D8DCE1",
      "--kf-border-soft":   "#ECEEF1",
      "--kf-text-primary":  "#1A1D21",
      "--kf-text-secondary":"#4B515A",
      "--kf-text-muted":    "#636A73",
      "--kf-accent":           "#0369A1",
      "--kf-accent-fg":        "#FFFFFF",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#C9CDD3",
      "--kf-scrollbar-track":  "#ECEEF1",
    },
  },
  // ── Windows 11 標準エクスプローラー風 ─────────────────────────────────────
  // 配色は Windows 11 のエクスプローラーに寄せ、uiStyle: "win11" で角丸・
  // 行の余白・細いスクロールバーといった形状まで合わせる。
  {
    id: "windows11-light",
    name: "Windows 11 (Light)",
    mode: "light",
    uiStyle: "win11",
    vars: {
      // コンテンツは白、ツールバー/タブ帯は Mica 相当のライトグレー。
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F3F3F3",
      "--kf-bg-tertiary":   "#EAEAEA",
      "--kf-border":        "#DCDCDC",
      "--kf-border-soft":   "#EFEFEF",
      "--kf-text-primary":  "#1A1A1A",
      "--kf-text-secondary":"#5D5D5D",
      "--kf-text-muted":    "#6E6E6E",
      "--kf-accent":           "#0067C0",
      "--kf-accent-fg":        "#FFFFFF",
      "--kf-window-title-bg":  "#F3F3F3",
      "--kf-scrollbar-thumb":  "#C4C4C4",
      "--kf-scrollbar-track":  "#F3F3F3",
    },
  },
  {
    id: "windows11-dark",
    name: "Windows 11 (Dark)",
    mode: "dark",
    uiStyle: "win11",
    vars: {
      // リスト面 #272727 / ウィンドウ面 #202020 という Win11 dark の二層構成。
      "--kf-bg-primary":    "#272727",
      "--kf-bg-secondary":  "#202020",
      "--kf-bg-tertiary":   "#2F2F2F",
      "--kf-border":        "#3D3D3D",
      "--kf-border-soft":   "#2E2E2E",
      "--kf-text-primary":  "#FFFFFF",
      "--kf-text-secondary":"#C5C5C5",
      "--kf-text-muted":    "#9B9B9B",
      "--kf-accent":           "#4CC2FF",
      "--kf-accent-fg":        "#00243B",
      "--kf-window-title-bg":  "#202020",
      "--kf-scrollbar-thumb":  "#4D4D4D",
      "--kf-scrollbar-track":  "#272727",
    },
  },
  // ── Neutral ──────────────────────────────────────────────────────────────
  {
    id: "dark",
    name: "Dark",
    mode: "dark",
    vars: {
      "--kf-bg-primary":    "#171717",
      "--kf-bg-secondary":  "#262626",
      "--kf-bg-tertiary":   "#333333",
      "--kf-border":        "#404040",
      "--kf-border-soft":   "#2E2E2E",
      "--kf-text-primary":  "#F0F0F0",
      "--kf-text-secondary":"#B8B8B8",
      "--kf-text-muted":    "#888888",
      "--kf-accent":           "#3b82f6",
      "--kf-window-title-bg":  "#171717",
      "--kf-scrollbar-thumb":  "#404040",
      "--kf-scrollbar-track":  "#262626",
    },
  },
  {
    id: "light",
    name: "Light",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#2563eb",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  // ── Solarized ─────────────────────────────────────────────────────────────
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#268bd2",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#2aa198",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  // ── Popular themes (white base, accent-only identity) ─────────────────────
  {
    id: "dracula",
    name: "Dracula",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#8B5CF6",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  {
    id: "nord",
    name: "Nord",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#5E81AC",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#3D9900",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#3B82C4",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#5D9FE8",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#4A7FD4",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#427B58",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  // ── Light themes ──────────────────────────────────────────────────────────
  {
    id: "github-light",
    name: "GitHub Light",
    mode: "light",
    vars: {
      "--kf-bg-primary":    "#FFFFFF",
      "--kf-bg-secondary":  "#F7F7F8",
      "--kf-bg-tertiary":   "#EEEEEF",
      "--kf-border":        "#DCDCDD",
      "--kf-border-soft":   "#F0F0F1",
      "--kf-text-primary":  "#111111",
      "--kf-text-secondary":"#444444",
      "--kf-text-muted":    "#777777",
      "--kf-accent":           "#0969da",
      "--kf-window-title-bg":  "#FFFFFF",
      "--kf-scrollbar-thumb":  "#D4D4D5",
      "--kf-scrollbar-track":  "#F0F0F1",
    },
  },
  // ── Accessibility ─────────────────────────────────────────────────────────
  {
    id: "high-contrast",
    name: "High Contrast",
    mode: "dark",
    vars: {
      "--kf-bg-primary":    "#000000",
      "--kf-bg-secondary":  "#0d0d0d",
      "--kf-bg-tertiary":   "#1a1a1a",
      "--kf-border":        "#555555",
      "--kf-border-soft":   "#2a2a2a",
      "--kf-text-primary":  "#ffffff",
      "--kf-text-secondary":"#eeeeee",
      "--kf-text-muted":    "#cccccc",
      "--kf-accent":           "#00aaff",
      "--kf-window-title-bg":  "#000000",
      "--kf-scrollbar-thumb":  "#1a1a1a",
      "--kf-scrollbar-track":  "#0d0d0d",
    },
  },
];

export const THEME_MAP = Object.fromEntries(
  THEMES.map((t) => [t.id, t])
) as Record<ThemeId, ThemeDefinition>;

const CUSTOM_THEME_KEY = "shirube-custom-theme";

export function loadCustomTheme(): ThemeDefinition | null {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_KEY);
    return raw ? (JSON.parse(raw) as ThemeDefinition) : null;
  } catch {
    return null;
  }
}

export function saveCustomTheme(theme: ThemeDefinition): void {
  localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(theme));
}

// ── User-defined named presets ─────────────────────────────────────
export type UserPreset = {
  id: string;   // "user-<timestamp>"
  name: string;
  mode: ColorMode;
  vars: Record<string, string>;
};

const USER_PRESETS_KEY = "shirube-user-presets";

export function loadUserPresets(): UserPreset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    const presets: UserPreset[] = raw ? JSON.parse(raw) : [];
    // Migrate legacy single "custom" slot on first use
    if (presets.length === 0) {
      const legacy = loadCustomTheme();
      if (legacy) {
        const migrated: UserPreset = {
          id: "user-migrated",
          name: "カスタム",
          mode: legacy.mode,
          vars: legacy.vars,
        };
        saveUserPresets([migrated]);
        return [migrated];
      }
    }
    return presets;
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: UserPreset[]): void {
  localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
}

/** All CSS variable keys used by shirube-filer themes. */
export const THEME_VAR_LABELS: { key: string; label: string }[] = [
  { key: "--kf-bg-primary",    label: "背景（メイン）" },
  { key: "--kf-bg-secondary",  label: "背景（サブ）" },
  { key: "--kf-bg-tertiary",   label: "背景（第3）" },
  { key: "--kf-border",        label: "ボーダー" },
  { key: "--kf-border-soft",   label: "ボーダー（弱）" },
  { key: "--kf-text-primary",  label: "テキスト（メイン）" },
  { key: "--kf-text-secondary",label: "テキスト（サブ）" },
  { key: "--kf-text-muted",    label: "テキスト（薄）" },
  { key: "--kf-accent",          label: "アクセントカラー" },
  { key: "--kf-accent-fg",       label: "アクセント文字色" },
  { key: "--kf-window-title-bg", label: "タイトルバー背景色" },
  { key: "--kf-scrollbar-thumb", label: "スクロールバー（つまみ）" },
  { key: "--kf-scrollbar-track", label: "スクロールバー（背景）" },
];

export const ThemeContext = createContext<{
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;
}>({
  themeId: "shirube-dark",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}
