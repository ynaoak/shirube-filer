import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setLanguage, type Language } from "../i18n";

const KEY = "shirube-ui-settings";
const EVENT = "kf-ui-settings-change";
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kf-ui-settings") : null;

export type PreviewType = "auto" | "text" | "image" | "video" | "audio" | "pdf" | "none";

export type UiSettings = {
  showHiddenFiles: boolean;
  terminalShell: string;
  language: Language;
  /** 拡張子（ドットなし小文字）→ プレビュータイプのオーバーライド */
  previewExtConfig: Record<string, PreviewType>;
  /** ファイル一覧リスト表示：列ごとの縦区切り線 */
  showColumnDividers: boolean;
  /** ファイル一覧リスト表示：行ごとの横区切り線 */
  showRowDividers: boolean;
  /** ファイル選択時にプレビューパネルを自動表示する */
  autoShowPreview: boolean;
  /** package.json / Cargo.toml / Makefile にフォーカスが当たったらタスクパネルを自動表示する */
  autoShowTaskPanel: boolean;
  /** テキストプレビューの配色（shiki の VS Code テーマ id）。
   *  "dark"=dark-plus（後方互換の既定） / "light"=light-plus / "app"=アプリテーマに従う /
   *  組み込みテーマ id（github-dark 等） / "custom"=インポートした VS Code テーマ */
  codePreviewTheme:
    | "app" | "dark" | "light"
    | "github-dark" | "github-light" | "one-dark-pro" | "monokai" | "nord" | "dracula"
    | "custom";
  /** マークダウンプレビューの配色: "app"=アプリテーマに従う（既定） / "dark"=ダーク固定 */
  markdownPreviewTheme: "app" | "dark";
  /** シンタックスハイライトのトークン別カスタム色（キー: bg/fg/keyword/string/comment/
   *  number/function/type/attr/meta、値: #RRGGBB）。未設定トークンは配色既定のまま。 */
  codeHighlightColors: Record<string, string>;
  /** インポートした VS Code テーマ（JSON）。codePreviewTheme === "custom" のときに使用。 */
  customCodeTheme: Record<string, unknown> | null;
  /** フォルダ一覧表示時にフォルダサイズを自動計算する */
  autoCalcDirSizes: boolean;
  /** 拡張子（ドットなし小文字）→ 起動アプリのパス */
  fileAssociations: Record<string, string>;
  /** OS のアクセントカラーをテーマの --kf-accent に反映する（Windows） */
  followOsAccent: boolean;
  /** クラウド同期履歴の保持件数（超過分は古い順に破棄）。既定 10000。 */
  syncHistoryLimit: number;
  /** ファイル一覧のアイコンセット。
   *  "material"（既定）= 内蔵の Material Symbols（単色・フラット）/
   *  "dimensional" = 内蔵の立体アイコン（グラデーションと陰影を持つ自作 SVG）/
   *  "system" = OS シェルのアイコン（Windows エクスプローラーと同じ絵柄）。
   *  system は非 Windows では取得できないため内蔵アイコンにフォールバックする。 */
  iconSet: IconSet;
};

/** ファイル一覧のアイコンセット。一覧とドラッグ中のカードで共有する。 */
export type IconSet = "material" | "dimensional" | "system";

function readSettings(): UiSettings {
  const savedLang = (localStorage.getItem("shirube-language") as Language) ?? "ja";
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiSettings>;
      return {
        showHiddenFiles: parsed.showHiddenFiles ?? false,
        terminalShell: parsed.terminalShell ?? "",
        language: parsed.language ?? savedLang,
        previewExtConfig: parsed.previewExtConfig ?? {},
        showColumnDividers: parsed.showColumnDividers ?? false,
        showRowDividers: parsed.showRowDividers ?? false,
        autoShowPreview: parsed.autoShowPreview ?? false,
        autoShowTaskPanel: parsed.autoShowTaskPanel ?? true,
        codePreviewTheme: parsed.codePreviewTheme ?? "dark",
        markdownPreviewTheme: parsed.markdownPreviewTheme ?? "app",
        codeHighlightColors: parsed.codeHighlightColors ?? {},
        customCodeTheme: parsed.customCodeTheme ?? null,
        autoCalcDirSizes: parsed.autoCalcDirSizes ?? false,
        fileAssociations: parsed.fileAssociations ?? {},
        followOsAccent: parsed.followOsAccent ?? false,
        syncHistoryLimit: parsed.syncHistoryLimit ?? 10000,
        iconSet: parsed.iconSet ?? "material",
      };
    }
  } catch {
    // ignore
  }
  return { showHiddenFiles: false, terminalShell: "", language: savedLang, previewExtConfig: {}, showColumnDividers: false, showRowDividers: false, autoShowPreview: false, autoShowTaskPanel: true, autoCalcDirSizes: false, fileAssociations: {}, followOsAccent: false, codePreviewTheme: "dark", markdownPreviewTheme: "app", codeHighlightColors: {}, customCodeTheme: null, syncHistoryLimit: 10000, iconSet: "material" };
}

function mergeSettings(base: UiSettings, override: Partial<UiSettings>): UiSettings {
  return {
    showHiddenFiles: override.showHiddenFiles ?? base.showHiddenFiles,
    terminalShell: override.terminalShell ?? base.terminalShell,
    language: override.language ?? base.language,
    previewExtConfig: { ...base.previewExtConfig, ...(override.previewExtConfig ?? {}) },
    showColumnDividers: override.showColumnDividers ?? base.showColumnDividers,
    showRowDividers: override.showRowDividers ?? base.showRowDividers,
    autoShowPreview: override.autoShowPreview ?? base.autoShowPreview,
    autoShowTaskPanel: override.autoShowTaskPanel ?? base.autoShowTaskPanel,
    codePreviewTheme: override.codePreviewTheme ?? base.codePreviewTheme,
    markdownPreviewTheme: override.markdownPreviewTheme ?? base.markdownPreviewTheme,
    codeHighlightColors: override.codeHighlightColors ?? base.codeHighlightColors,
    customCodeTheme: override.customCodeTheme !== undefined ? override.customCodeTheme : base.customCodeTheme,
    autoCalcDirSizes: override.autoCalcDirSizes ?? base.autoCalcDirSizes,
    fileAssociations: { ...base.fileAssociations, ...(override.fileAssociations ?? {}) },
    followOsAccent: override.followOsAccent ?? base.followOsAccent,
    syncHistoryLimit: override.syncHistoryLimit ?? base.syncHistoryLimit,
    iconSet: override.iconSet ?? base.iconSet,
  };
}

/** アプリ起動時に設定ファイルを読み込み、localStorageとマージする */
export async function loadSettingsFromFile(): Promise<void> {
  try {
    const json = await invoke<string>("load_ui_settings");
    if (!json) return;
    const fromFile = JSON.parse(json) as Partial<UiSettings>;
    const current = readSettings();
    // ファイルの値でlocalStorageをオーバーライド
    const merged = mergeSettings(current, fromFile);
    localStorage.setItem(KEY, JSON.stringify(merged));
    if (merged.language) setLanguage(merged.language);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: merged }));
  } catch {
    // ファイルが存在しない・パースエラーは無視
  }
}

function writeSettings(patch: Partial<UiSettings>): void {
  const next = { ...readSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  if (patch.language) {
    setLanguage(patch.language);
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  // Cross-window sync via BroadcastChannel
  bc?.postMessage(next);
  // 設定ファイルにも非同期で書き込む
  invoke("save_ui_settings", { json: JSON.stringify(next, null, 2) }).catch(() => {/* ignore */});
}

export function useUiSettings(): [UiSettings, (patch: Partial<UiSettings>) => void] {
  const [settings, setSettings] = useState<UiSettings>(readSettings);

  useEffect(() => {
    const handler = (e: Event) => {
      setSettings((e as CustomEvent<UiSettings>).detail);
    };
    window.addEventListener(EVENT, handler);
    // Cross-window sync: receive changes from other windows (e.g. settings window)
    const bcHandler = (e: MessageEvent<UiSettings>) => {
      localStorage.setItem(KEY, JSON.stringify(e.data));
      if (e.data.language) setLanguage(e.data.language);
      setSettings(e.data);
    };
    bc?.addEventListener("message", bcHandler);
    return () => {
      window.removeEventListener(EVENT, handler);
      bc?.removeEventListener("message", bcHandler);
    };
  }, []);

  return [settings, writeSettings];
}
