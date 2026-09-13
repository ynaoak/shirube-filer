import { useState, useEffect, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ThemeContext, ThemeId, THEME_MAP, UiStyle, loadCustomTheme, loadUserPresets } from "../../store/themeStore";
import { readableTextOn } from "../../lib/contrastColor";

function applyTitleBarColor(hex: string) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  invoke("set_title_bar_color", { r, g, b }).catch(() => {});
}

const STORAGE_KEY = "shirube-theme";
const themeBc = new BroadcastChannel("kf-theme");

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<ThemeId>(() => {
    return (localStorage.getItem(STORAGE_KEY) as ThemeId) ?? "shirube-dark";
  });

  const setTheme = (id: ThemeId) => {
    setThemeId(id);
    localStorage.setItem(STORAGE_KEY, id);
    applyTheme(id);
    themeBc.postMessage(id);
  };

  // 初回適用
  useEffect(() => {
    applyTheme(themeId);
    maybeApplyOsAccent();
  }, []);

  // 他ウィンドウからのテーマ変更を受信して反映
  useEffect(() => {
    const handler = (e: MessageEvent<ThemeId>) => {
      setThemeId(e.data);
      applyTheme(e.data);
    };
    themeBc.addEventListener("message", handler);
    return () => themeBc.removeEventListener("message", handler);
  }, []);

  // "system" テーマ選択時: prefers-color-scheme の変化を追跡
  useEffect(() => {
    if (themeId !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyTheme("system");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themeId]);

  return (
    <ThemeContext.Provider value={{ themeId, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function applyVars(vars: Record<string, string>, mode: "dark" | "light", uiStyle?: UiStyle) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
  // アクセント上の文字色は必ず毎回入れ直す。
  // --kf-accent-fg を定義しているのは一部のテーマだけで、未定義のまま切り替えると
  // 直前のテーマ（や :root の既定 #08334A）の濃色が residual として残り、
  // 「色付きの背景に黒文字」で読めなくなる。テーマが明示していれば尊重し、
  // していなければアクセント色から読める色を選ぶ。
  const accent = vars["--kf-accent"];
  if (accent) {
    root.style.setProperty("--kf-accent-fg", vars["--kf-accent-fg"] ?? readableTextOn(accent));
  }
  if (mode === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  // 形状（角丸・行の余白など）は App.css の [data-ui-style="..."] で切り替える。
  // 既定デザインのテーマでは属性ごと外して素の見た目に戻す。
  if (uiStyle) root.setAttribute("data-ui-style", uiStyle);
  else root.removeAttribute("data-ui-style");
  const titleBg = vars["--kf-window-title-bg"];
  if (titleBg) applyTitleBarColor(titleBg);
  // テーマ適用でアクセントが上書きされるので、OS 追従が有効なら再度かぶせる。
  maybeApplyOsAccent();
}

/**
 * UI 設定 followOsAccent が有効なら、OS のアクセントカラーを --kf-accent に反映する。
 * 設定は localStorage の "shirube-ui-settings" から直読みする（循環依存回避）。
 */
export function maybeApplyOsAccent() {
  let enabled = false;
  try {
    const raw = localStorage.getItem("shirube-ui-settings");
    if (raw) enabled = !!(JSON.parse(raw).followOsAccent);
  } catch {
    /* ignore */
  }
  if (!enabled) return;
  invoke<string | null>("get_os_accent_color")
    .then((hex) => {
      if (hex && /^#[0-9A-Fa-f]{6}$/.test(hex)) {
        document.documentElement.style.setProperty("--kf-accent", hex);
        // 前景を追従させないと、濃色アクセント（紺など）のときに
        // テーマ既定の濃色前景が残り「紺背景に黒文字」で読めなくなる。
        // 選択ハイライト・ボタン・チップ等の accent-fg 利用箇所すべてに効く。
        document.documentElement.style.setProperty("--kf-accent-fg", readableTextOn(hex));
      }
    })
    .catch(() => {});
}

export function applyTheme(id: ThemeId) {
  // system テーマ: OS 設定に合わせて dark / light を選択
  if (id === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? "shirube-dark" : "shirube-light");
    return;
  }

  if (id === "custom") {
    const custom = loadCustomTheme();
    if (!custom) return;
    applyVars(custom.vars, custom.mode);
    return;
  }

  // User-defined named preset
  if (id.startsWith("user-")) {
    const preset = loadUserPresets().find((p) => p.id === id);
    if (!preset) return;
    applyVars(preset.vars, preset.mode);
    return;
  }

  const theme = THEME_MAP[id];
  if (!theme) return;
  applyVars(theme.vars, theme.mode, theme.uiStyle);
}
