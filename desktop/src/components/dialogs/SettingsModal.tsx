import { useState, useEffect, useContext } from "react";
import i18n from "../../i18n";
import { HL_TOKEN_KEYS } from "../../lib/highlightTheme";
import { BUILTIN_THEME_IDS } from "../../lib/shikiHighlighter";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";
import ThemeEditor from "./ThemeEditor";
import KeybindingSettings from "./KeybindingSettings";
import { useTheme, THEMES, loadUserPresets, saveUserPresets, UserPreset, loadCustomTheme, saveCustomTheme } from "../../store/themeStore";
import { applyTheme, maybeApplyOsAccent } from "../providers/ThemeProvider";
import { LayoutContext } from "../../store/layoutStore";
import { AddonContext } from "../../store/addonStore";
import { useUiSettings, PreviewType, UiSettings } from "../../store/uiSettingsStore";
import { serializeLayout, deserializeLayout, LayoutFormat } from "../../utils/layoutSerializer";
import { Layout } from "../../types/layout";
import type { Language } from "../../i18n";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { HAS_UPDATER } from "../../buildConfig";
import UpdateChecker from "../common/UpdateChecker";
import { getVersion } from "@tauri-apps/api/app";

const FEEDBACK_URL = "https://github.com/ynaoak/shirube-filer/issues/new";

type Tab = "general" | "theme" | "keybindings" | "display" | "layout" | "preview" | "addon" | "data";

type Props = {
  onClose: () => void;
  /** trueのとき独立ウィンドウとしてフルスクリーン表示 */
  standalone?: boolean;
  /** 初期表示タブ */
  initialTab?: Tab;
};

// ファイル選択ダイアログのフィルタ名は表示言語に合わせる
const exeFilters = () => [
  { name: i18n.t("settings.filterExecutable"), extensions: ["exe", "cmd", "bat"] },
  { name: i18n.t("settings.filterAllFiles"), extensions: ["*"] },
];

// 組み込み shiki テーマ id → i18n ラベルキー（dark-plus / light-plus は
// codePreviewTheme の "dark" / "light" に対応するため別扱い＝ここには含めない）。
const BUILTIN_THEME_LABEL_KEYS: Record<string, string> = {
  "github-dark": "settings.previewThemeGithubDark",
  "github-light": "settings.previewThemeGithubLight",
  "one-dark-pro": "settings.previewThemeOneDarkPro",
  monokai: "settings.previewThemeMonokai",
  nord: "settings.previewThemeNord",
  dracula: "settings.previewThemeDracula",
};

/** VS Code テーマ JSON（JSONC）から行コメント・ブロックコメント・末尾カンマを除去する。 */
function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n\r]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

function parseExts(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}

/** アプリごとのグループ行 */
function AppAssociationGroup({
  appPath,
  exts,
  onAppChange,
  onAddExt,
  onRemoveExt,
  onDeleteGroup,
}: {
  appPath: string;
  exts: string[];
  onAppChange: (newPath: string) => void;
  onAddExt: (ext: string) => void;
  onRemoveExt: (ext: string) => void;
  onDeleteGroup: () => void;
}) {
  const { t } = useTranslation();
  const [localPath, setLocalPath] = useState(appPath);
  const [addingExt, setAddingExt] = useState("");
  useEffect(() => { setLocalPath(appPath); }, [appPath]);

  const handleBrowse = async () => {
    const selected = await open({ multiple: false, directory: false, filters: exeFilters() });
    if (typeof selected === "string") onAppChange(selected);
  };

  const commitAddExt = () => {
    for (const ext of parseExts(addingExt)) onAddExt(ext);
    setAddingExt("");
  };

  return (
    <div className="rounded flex flex-col gap-1.5 p-2" style={{ border: "1px solid var(--kf-border)", backgroundColor: "var(--kf-bg-primary)" }}>
      {/* アプリパス行 */}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={localPath}
          onChange={(e) => setLocalPath(e.target.value)}
          onBlur={() => { if (localPath !== appPath) onAppChange(localPath); }}
          className="flex-1 rounded px-2 py-1 text-xs outline-none font-mono min-w-0"
          style={{
            backgroundColor: "var(--kf-bg-secondary)",
            border: "1px solid var(--kf-border)",
            color: "var(--kf-text-primary)",
          }}
        />
        <button
          onClick={handleBrowse}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs shrink-0 hover:opacity-80"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)", backgroundColor: "var(--kf-bg-secondary)" }}
          title={t("settings.selectApp")}
        >
          <Icon name="folder_open" size={12} />
        </button>
        <button
          onClick={onDeleteGroup}
          className="flex items-center px-1.5 py-1 rounded text-xs shrink-0 hover:opacity-80"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-error)", backgroundColor: "var(--kf-bg-secondary)" }}
          title={t("settings.deleteAppAssoc")}
        >
          <Icon name="delete" size={12} />
        </button>
      </div>
      {/* 拡張子チップ + インライン追加 */}
      <div className="flex flex-wrap items-center gap-1">
        {exts.map((ext) => (
          <span
            key={ext}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-xs"
            style={{ backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-accent)", border: "1px solid var(--kf-border)" }}
          >
            .{ext}
            <button
              onClick={() => onRemoveExt(ext)}
              className="hover:opacity-70 ml-0.5"
              title={t("settings.removeExt", { ext })}
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={addingExt}
          onChange={(e) => setAddingExt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commitAddExt(); }}
          placeholder={t("settings.addExtPlaceholder")}
          className="rounded px-2 py-0.5 text-xs outline-none font-mono"
          style={{
            width: 110,
            backgroundColor: "var(--kf-bg-secondary)",
            border: "1px solid var(--kf-border)",
            color: "var(--kf-text-primary)",
          }}
        />
        <button
          onClick={commitAddExt}
          disabled={!addingExt.trim()}
          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs hover:opacity-80 disabled:opacity-30"
          style={{ border: "1px solid var(--kf-border)", color: "var(--kf-accent)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <Icon name="add" size={11} />
          {t("settings.addExt")}
        </button>
      </div>
    </div>
  );
}

/** 新規アプリ追加行 */
function NewAssociationRow({ onAdd }: { onAdd: (exts: string[], appPath: string) => void }) {
  const { t } = useTranslation();
  const [newExts, setNewExts] = useState("");
  const add = async () => {
    const exts = parseExts(newExts);
    if (!exts.length) return;
    const selected = await open({ multiple: false, directory: false, filters: exeFilters() });
    if (typeof selected !== "string") return;
    onAdd(exts, selected);
    setNewExts("");
  };
  return (
    <div className="flex items-center gap-2 pt-1 border-t" style={{ borderColor: "var(--kf-border)" }}>
      <span className="text-xs shrink-0" style={{ color: "var(--kf-text-muted)" }}>{t("settings.extLabel")}</span>
      <input
        type="text"
        value={newExts}
        onChange={(e) => setNewExts(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        placeholder={t("settings.extPlaceholder")}
        className="flex-1 rounded px-2 py-1 text-xs outline-none font-mono"
        style={{
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      />
      <button
        onClick={add}
        disabled={!newExts.trim()}
        className="flex items-center gap-1 px-2 py-1 rounded text-xs shrink-0 hover:opacity-80 disabled:opacity-30"
        style={{
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-secondary)",
          backgroundColor: "var(--kf-bg-primary)",
        }}
      >
        <Icon name="folder_open" size={12} />
        {t("settings.selectAppAndAdd")}
      </button>
    </div>
  );
}

/** テーマのミニプレビューカード */
function ThemeCard({
  name,
  vars,
  selected,
  onSelect,
  onDelete,
}: {
  name: string;
  vars: Record<string, string>;
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const bg   = vars["--kf-bg-primary"]   ?? "#333";
  const bg2  = vars["--kf-bg-secondary"] ?? "#444";
  const bg3  = vars["--kf-bg-tertiary"]  ?? "#555";
  const acc  = vars["--kf-accent"]       ?? "#888";
  const border = selected ? acc : "var(--kf-border)";

  return (
    <div
      className="relative flex flex-col items-center gap-1 cursor-pointer group"
      style={{ width: 72 }}
      onClick={onSelect}
      title={name}
    >
      {/* カラープレビュー */}
      <div
        className="rounded overflow-hidden shrink-0"
        style={{
          width: 64,
          height: 46,
          border: `2px solid ${border}`,
          outline: selected ? `1px solid ${acc}` : "none",
          outlineOffset: 1,
        }}
      >
        {/* メイン背景エリア */}
        <div style={{ backgroundColor: bg, height: "55%", padding: "4px 5px", display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ backgroundColor: bg3, height: 3, borderRadius: 2, width: "75%" }} />
          <div style={{ backgroundColor: bg3, height: 3, borderRadius: 2, width: "50%", opacity: 0.6 }} />
        </div>
        {/* サブ背景エリア */}
        <div style={{ backgroundColor: bg2, height: "30%", display: "flex", alignItems: "center", paddingInline: 5, gap: 3 }}>
          <div style={{ backgroundColor: acc, width: 8, height: 8, borderRadius: "50%" }} />
          <div style={{ backgroundColor: acc, height: 2.5, borderRadius: 2, flex: 1, opacity: 0.35 }} />
        </div>
        {/* アクセントストリップ */}
        <div style={{ backgroundColor: acc, height: "15%" }} />
      </div>
      {/* テーマ名 */}
      <span
        className="text-center leading-tight break-words"
        style={{ fontSize: 10, maxWidth: 68, color: selected ? acc : "var(--kf-text-secondary)" }}
      >
        {name}
      </span>
      {/* 削除ボタン（ユーザープリセットのみ） */}
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-full flex items-center justify-center"
          style={{ width: 14, height: 14, backgroundColor: "var(--kf-error)", color: "#fff" }}
          title={t("settings.themeDeletePreset")}
        >
          <Icon name="close" size={10} />
        </button>
      )}
      {/* 選択チェック */}
      {selected && (
        <div
          className="absolute top-0 left-0 rounded-full flex items-center justify-center"
          style={{ width: 16, height: 16, backgroundColor: acc, color: "#fff" }}
        >
          <Icon name="check" size={11} />
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div
      className="relative w-9 h-5 rounded-full transition-colors cursor-pointer shrink-0"
      style={{ backgroundColor: on ? "var(--kf-accent)" : "var(--kf-bg-tertiary)" }}
      onClick={onToggle}
    >
      <div
        className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
        style={{ left: on ? "calc(100% - 18px)" : "2px", backgroundColor: "#fff" }}
      />
    </div>
  );
}

export default function SettingsModal({ onClose, standalone = false, initialTab }: Props) {
  const { t } = useTranslation();
  // Esc は既存の window ハンドラで処理するため closeOnEsc は無効（二重発火回避）。
  const dialogRef = useModal<HTMLDivElement>({ onClose, closeOnEsc: false });
  const TABS: { id: Tab; label: string; icon: string; disabled?: boolean }[] = [
    { id: "general",     label: t("settings.tabGeneral"),     icon: "settings" },
    { id: "display",     label: t("settings.tabDisplay"),     icon: "tune" },
    { id: "theme",       label: t("settings.tabTheme"),       icon: "palette" },
    { id: "preview",     label: t("settings.tabPreview"),      icon: "preview" },
    { id: "keybindings", label: t("settings.tabKeybindings"), icon: "keyboard" },
    { id: "addon",       label: t("settings.tabAddon"),        icon: "extension",    disabled: true },
    { id: "data",        label: t("settings.tabData"),         icon: "import_export" },
    ...(!standalone ? [{ id: "layout" as Tab, label: t("settings.tabLayout"), icon: "view_quilt" }] : []),
  ];

  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? "general");
  // 一般タブの「アプリ情報」に表示するバージョン（取得失敗時は "—" のまま）
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);
  const { themeId, setTheme } = useTheme();
  const [userPresets, setUserPresets] = useState<UserPreset[]>(() => loadUserPresets());
  const layoutCtx = useContext(LayoutContext);
  const layout = layoutCtx?.layout;
  const layoutDispatch = layoutCtx?.dispatch ?? (() => {});
  const addonCtx = useContext(AddonContext);
  const [uiSettings, setUiSettings] = useUiSettings();
  const [layoutFormat, setLayoutFormat] = useState<LayoutFormat>("json");
  const [layoutStatus, setLayoutStatus] = useState<string | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);
  const [settingsFilePath, setSettingsFilePath] = useState<string>("");
  const [addonInstalling, setAddonInstalling] = useState(false);
  const [addonInstallError, setAddonInstallError] = useState<string | null>(null);
  const [addonUninstallingId, setAddonUninstallingId] = useState<string | null>(null);
  const [detectedShells, setDetectedShells] = useState<{ name: string; path: string }[] | null>(null);
  // 同期履歴の破棄（データタブ）: 指定日時以前を手動で破棄する
  const [historyCutoff, setHistoryCutoff] = useState("");
  const [historyStatus, setHistoryStatus] = useState<string | null>(null);

  const handleDiscardHistory = async () => {
    if (!historyCutoff) return;
    const cutoff = new Date(historyCutoff);
    if (Number.isNaN(cutoff.getTime())) return;
    if (!window.confirm(t("settings.syncHistoryDiscardConfirm", { date: cutoff.toLocaleString() }))) return;
    try {
      const removed = await invoke<number>("clear_sync_history", {
        beforeTs: Math.floor(cutoff.getTime() / 1000),
      });
      setHistoryStatus(t("settings.syncHistoryDiscarded", { count: removed }));
    } catch (e) {
      setHistoryStatus(String(e));
    }
  };

  // ── インポート・エクスポート ─────────────────────────────────────────────
  const EXPORT_SECTIONS = [
    { key: "layout",      label: t("settings.exportSectionLayout"),      icon: "view_quilt" },
    { key: "theme",       label: t("settings.exportSectionTheme"),       icon: "palette" },
    { key: "uiSettings",  label: t("settings.exportSectionUiSettings"),  icon: "tune" },
    { key: "keybindings", label: t("settings.exportSectionKeybindings"), icon: "keyboard" },
    { key: "bookmarks",   label: t("settings.exportSectionBookmarks"),   icon: "bookmark" },
    { key: "contextMenu", label: t("settings.exportSectionContextMenu"), icon: "menu" },
    // クラウド接続: load_sync_jobs は YAML（シークレットは保存時にキーチェーンへ
    // 退避され空文字化済み）から読むため、エクスポートに秘匿情報は含まれない。
    { key: "cloudSync",   label: t("settings.exportSectionCloudSync"),   icon: "cloud" },
  ] as const;
  type ExportKey = typeof EXPORT_SECTIONS[number]["key"];

  const [exportSections, setExportSections] = useState<Record<ExportKey, boolean>>({
    layout: true, theme: true, uiSettings: true,
    keybindings: true, bookmarks: true, contextMenu: true, cloudSync: true,
  });
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [importDragOver, setImportDragOver] = useState(false);
  const [importPreview, setImportPreview] = useState<Record<string, unknown> | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [clearStatus, setClearStatus] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  // すべてのデータを削除（初期化）。設定ディレクトリ・localStorage・OS 資格情報
  // ストアのシークレットを一括で消す。アンインストール前のクリーンアップ用。
  const handleClearAllData = async () => {
    if (!window.confirm(t("settings.dataClearConfirm"))) return;
    setClearing(true);
    setClearStatus(null);
    try {
      // 1) OS 資格情報ストアのシークレットを削除
      //    1-a) クラウド同期ジョブ（account: `<jobId>:<provider>.<field>`）
      const SYNC_SECRET_FIELDS: Record<string, string[]> = {
        s3: ["secretKey"], sftp: ["password"], webdav: ["password"],
      };
      try {
        const jobs = await invoke<Array<{ id: string; provider: string }>>("load_sync_jobs");
        for (const job of jobs) {
          for (const field of SYNC_SECRET_FIELDS[job.provider] ?? []) {
            await invoke("secret_delete", { account: `${job.id}:${job.provider}.${field}` }).catch(() => {});
          }
        }
      } catch { /* ignore */ }
      //    1-b) クラウドアドオンのプロファイル（account: `<provider>:<id>:refreshToken`）
      for (const provider of ["box", "dropbox", "gcs", "gdrive", "onedrive"]) {
        try {
          const profiles: Array<{ id: string }> = JSON.parse(localStorage.getItem(`kf-${provider}-profiles`) ?? "[]");
          for (const p of profiles) {
            await invoke("secret_delete", { account: `${provider}:${p.id}:refreshToken` }).catch(() => {});
          }
        } catch { /* ignore */ }
      }
      // 2) 設定ディレクトリを削除
      await invoke("clear_app_data");
      // 3) localStorage を全消去
      localStorage.clear();
      // 4) 再読み込み
      setClearStatus(t("settings.dataClearDone"));
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      setClearStatus(String(e));
      setClearing(false);
    }
  };

  // ── シンタックスハイライト色のエクスポート / インポート ──────────────
  const [hlStatus, setHlStatus] = useState<string | null>(null);
  const handleExportHighlight = async () => {
    try {
      const data = { version: 1, type: "shirube-highlight-theme", colors: uiSettings.codeHighlightColors };
      const path = await save({
        defaultPath: "shirube-highlight-theme.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("export_layout", { content: JSON.stringify(data, null, 2), path });
      setHlStatus(t("settings.hlExported"));
      setTimeout(() => setHlStatus(null), 2500);
    } catch (e) {
      setHlStatus(String(e));
    }
  };
  const handleImportHighlight = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof selected !== "string") return;
    try {
      const content = await invoke<string>("read_text_file", { path: selected, maxBytes: 1024 * 1024 });
      const data = JSON.parse(content) as { type?: string; colors?: Record<string, string> };
      if (data.type !== "shirube-highlight-theme" || typeof data.colors !== "object" || !data.colors) {
        throw new Error("invalid");
      }
      // 既知トークン・#RRGGBB のみ取り込む
      const colors: Record<string, string> = {};
      for (const key of HL_TOKEN_KEYS) {
        const v = data.colors[key];
        if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) colors[key] = v;
      }
      setUiSettings({ codeHighlightColors: colors });
      setHlStatus(t("settings.hlImported"));
      setTimeout(() => setHlStatus(null), 2500);
    } catch {
      setHlStatus(t("settings.hlImportError"));
    }
  };

  // ── VS Code テーマ（JSON）のインポート ────────────────────────────────
  const [themeImportStatus, setThemeImportStatus] = useState<string | null>(null);
  const handleImportVsCodeTheme = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof selected !== "string") return;
    try {
      const content = await invoke<string>("read_text_file", { path: selected, maxBytes: 2 * 1024 * 1024 });
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch {
        // VS Code のテーマ JSON は JSONC（コメント・末尾カンマ許容）のことが多いので緩く再試行
        data = JSON.parse(stripJsonComments(content));
      }
      if (typeof data !== "object" || data === null) throw new Error("invalid");
      const obj = data as Record<string, unknown>;
      const tokenColors = Array.isArray(obj.tokenColors) ? obj.tokenColors : undefined;
      const colors = obj.colors && typeof obj.colors === "object" ? (obj.colors as Record<string, unknown>) : undefined;
      if (!tokenColors && !colors) throw new Error("invalid");
      const sanitized: Record<string, unknown> = {
        name: typeof obj.name === "string" ? obj.name : (selected.split(/[\\/]/).pop() ?? "custom"),
        type: typeof obj.type === "string" ? obj.type : "dark",
        colors: colors ?? {},
        tokenColors: tokenColors ?? [],
      };
      if (typeof obj.semanticHighlighting === "boolean") sanitized.semanticHighlighting = obj.semanticHighlighting;
      if (obj.semanticTokenColors && typeof obj.semanticTokenColors === "object") {
        sanitized.semanticTokenColors = obj.semanticTokenColors;
      }
      setUiSettings({ customCodeTheme: sanitized, codePreviewTheme: "custom" });
      setThemeImportStatus(t("settings.vsCodeThemeImported"));
      setTimeout(() => setThemeImportStatus(null), 2500);
    } catch {
      setThemeImportStatus(t("settings.vsCodeThemeImportError"));
    }
  };
  const handleRemoveCustomTheme = () => {
    setUiSettings({
      customCodeTheme: null,
      codePreviewTheme: uiSettings.codePreviewTheme === "custom" ? "dark" : uiSettings.codePreviewTheme,
    });
  };

  const handleDataExport = async () => {
    try {
      const data: Record<string, unknown> = { version: 1, exportedAt: new Date().toISOString() };
      if (exportSections.layout && layout) data.layout = layout;
      if (exportSections.theme) data.theme = { activeId: themeId, customTheme: loadCustomTheme(), userPresets: loadUserPresets() };
      if (exportSections.uiSettings) data.uiSettings = uiSettings;
      if (exportSections.keybindings) data.keybindings = await invoke("load_keybindings").catch(() => null);
      if (exportSections.bookmarks) data.bookmarks = await invoke("load_bookmarks").catch(() => null);
      if (exportSections.contextMenu) data.contextMenu = await invoke("load_context_menu_config").catch(() => null);
      if (exportSections.cloudSync) data.cloudSync = await invoke("load_sync_jobs").catch(() => null);
      const content = JSON.stringify(data, null, 2);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const exportPath = await save({
        defaultPath: `shirube-filer-export-${timestamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!exportPath) return;
      await invoke("export_layout", { content, path: exportPath });
      setExportStatus(t("settings.dataExportComplete", { path: exportPath }));
    } catch (e) {
      setExportStatus(t("settings.dataError", { error: e }));
    }
  };

  const parseImportContent = (content: string) => {
    try {
      const data = JSON.parse(content) as Record<string, unknown>;
      setImportPreview(data);
      setImportStatus(null);
    } catch {
      setImportStatus(t("settings.dataJsonParseError"));
    }
  };

  const handleImportFilePick = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof selected !== "string") return;
    const content = await invoke<string>("read_text_file", { path: selected, maxBytes: 10 * 1024 * 1024 }).catch(() => "");
    if (content) parseImportContent(content);
    else setImportStatus(t("settings.dataFileReadError"));
  };

  const handleImportDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setImportDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => parseImportContent(ev.target?.result as string);
    reader.readAsText(file);
  };

  const handleApplyImport = async () => {
    if (!importPreview) return;
    try {
      if (importPreview.layout) {
        layoutDispatch({ type: "SET_LAYOUT", layout: importPreview.layout as Layout });
        await invoke("save_layout", { content: JSON.stringify(importPreview.layout), format: "json" }).catch(() => {});
      }
      if (importPreview.theme) {
        const th = importPreview.theme as { activeId?: string; customTheme?: ReturnType<typeof loadCustomTheme>; userPresets?: UserPreset[] };
        if (th.customTheme) saveCustomTheme(th.customTheme);
        if (th.userPresets) saveUserPresets(th.userPresets);
        if (th.activeId) { setTheme(th.activeId); applyTheme(th.activeId); }
      }
      if (importPreview.uiSettings) setUiSettings(importPreview.uiSettings as Parameters<typeof setUiSettings>[0]);
      if (importPreview.keybindings) await invoke("save_keybindings", { config: importPreview.keybindings }).catch(() => {});
      if (importPreview.bookmarks) await invoke("save_bookmarks", { bookmarks: importPreview.bookmarks }).catch(() => {});
      if (importPreview.contextMenu) await invoke("save_context_menu_config", { items: importPreview.contextMenu }).catch(() => {});
      // クラウド接続: シークレットはエクスポートに含まれないため、取り込み後は
      // 各接続でパスワード再入力 / OAuth 再接続が必要になる。
      if (Array.isArray(importPreview.cloudSync)) {
        await invoke("save_sync_jobs", { jobs: importPreview.cloudSync }).catch(() => {});
      }
      window.location.reload();
    } catch (e) {
      setImportStatus(t("settings.dataError", { error: e }));
    }
  };

  useEffect(() => {
    invoke<string>("get_ui_settings_path").then(setSettingsFilePath).catch(() => {});
  }, []);

  // display タブが初めて表示された時にシェル一覧を取得
  useEffect(() => {
    if (activeTab === "display" && detectedShells === null) {
      invoke<{ name: string; path: string }[]>("list_shells")
        .then(setDetectedShells)
        .catch(() => setDetectedShells([]));
    }
  }, [activeTab, detectedShells]);

  // マウント前（白画面フェーズ）に Escape が押されていた場合は即閉じる（遅延処理）
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    if (w.__kf_pending_escape) {
      delete w.__kf_pending_escape;
      onClose();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 通常の Escape: ウィンドウを閉じる（内部コンポーネントが stopPropagation していれば無効）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleAddonInstall = async () => {
    setAddonInstallError(null);
    try {
      const selected = await open({
        title: t("settings.addonZipTitle"),
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
        multiple: false,
        directory: false,
      });
      if (!selected) return;
      setAddonInstalling(true);
      await invoke("install_addon", { zipPath: selected as string });
      addonCtx?.reload();
    } catch (e) {
      setAddonInstallError(typeof e === "string" ? e : t("addonManager.installFailed"));
    } finally {
      setAddonInstalling(false);
    }
  };

  const handleAddonUninstall = async (id: string, name: string) => {
    if (!window.confirm(`${t("addonManager.confirmUninstall", { name })}\n${t("addonManager.confirmUninstallNote")}`)) return;
    setAddonUninstallingId(id);
    try {
      await invoke("uninstall_addon", { id });
      addonCtx?.reload();
    } catch (e) {
      setAddonInstallError(typeof e === "string" ? e : t("addonManager.uninstallFailed"));
    } finally {
      setAddonUninstallingId(null);
    }
  };

  const showLayoutStatus = (msg: string) => {
    setLayoutStatus(msg);
    setTimeout(() => setLayoutStatus(null), 3000);
  };

  const showSettingsStatus = (msg: string) => {
    setSettingsStatus(msg);
    setTimeout(() => setSettingsStatus(null), 3000);
  };

  const handleSettingsExport = async () => {
    try {
      const data = {
        version: 1,
        theme: {
          activeId: themeId,
          customTheme: loadCustomTheme(),
          userPresets: loadUserPresets(),
        },
        uiSettings,
        homePath: localStorage.getItem("kf-home-path") ?? "",
      };
      const content = JSON.stringify(data, null, 2);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const homePath = await invoke<string>("get_home_dir");
      const exportPath = `${homePath}/shirube-filer-settings-${timestamp}.json`;
      await invoke("export_layout", { content, path: exportPath });
      showSettingsStatus(t("settings.exportSuccess", { path: exportPath }));
    } catch (e) {
      showSettingsStatus(t("settings.exportError", { error: e }));
    }
  };

  const handleSettingsImport = async () => {
    try {
      const content = await invoke<string>("load_layout", { format: "json" });
      const data = JSON.parse(content) as {
        version: number;
        theme?: { activeId?: string; customTheme?: ReturnType<typeof loadCustomTheme>; userPresets?: UserPreset[] };
        uiSettings?: typeof uiSettings;
        homePath?: string;
      };
      if (data.theme) {
        if (data.theme.customTheme) saveCustomTheme(data.theme.customTheme);
        if (data.theme.userPresets) {
          saveUserPresets(data.theme.userPresets);
          setUserPresets(data.theme.userPresets);
        }
        if (data.theme.activeId) {
          setTheme(data.theme.activeId as Parameters<typeof setTheme>[0]);
          applyTheme(data.theme.activeId as Parameters<typeof applyTheme>[0]);
        }
      }
      if (data.uiSettings) setUiSettings(data.uiSettings);
      if (data.homePath) localStorage.setItem("kf-home-path", data.homePath);
      showSettingsStatus(t("settings.importSuccess"));
    } catch (e) {
      showSettingsStatus(t("settings.exportError", { error: e }));
    }
  };

  const handleLayoutSave = async () => {
    if (!layout) return;
    try {
      const content = serializeLayout(layout, layoutFormat);
      const path = await invoke<string>("save_layout", { content, format: layoutFormat });
      showLayoutStatus(t("settings.exportSuccess", { path }));
    } catch (e) {
      showLayoutStatus(t("settings.exportError", { error: e }));
    }
  };

  const handleLayoutLoad = async () => {
    try {
      const content = await invoke<string>("load_layout", { format: layoutFormat });
      const loaded = deserializeLayout(content, layoutFormat);
      layoutDispatch({ type: "SET_LAYOUT", layout: loaded as Layout });
      showLayoutStatus(t("settings.layoutLoaded"));
    } catch (e) {
      showLayoutStatus(t("settings.exportError", { error: e }));
    }
  };

  const handleLayoutExport = async () => {
    if (!layout) return;
    try {
      const content = serializeLayout(layout, layoutFormat);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const homePath = await invoke<string>("get_home_dir");
      const exportPath = `${homePath}/shirube-filer-layout-${timestamp}.${layoutFormat}`;
      await invoke("export_layout", { content, path: exportPath });
      showLayoutStatus(t("settings.exportSuccess", { path: exportPath }));
    } catch (e) {
      showLayoutStatus(t("settings.exportError", { error: e }));
    }
  };

  const inner = (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal={standalone ? undefined : true}
        aria-label={t("settings.title", "設定")}
        className={standalone ? "flex w-full h-full text-xs" : "kf-anim-scale flex rounded-lg shadow-xl overflow-hidden text-xs"}
        style={standalone ? {
          backgroundColor: "var(--kf-bg-primary)",
          color: "var(--kf-text-primary)",
        } : {
          width: "min(780px, 94vw)",
          height: "min(600px, 86vh)",
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          color: "var(--kf-text-primary)",
        }}
      >
        {/* Sidebar */}
        <div
          className="w-40 flex flex-col shrink-0 border-r"
          style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
        >
          {/* Header */}
          <div
            className="flex items-center gap-2 px-3 py-2.5 border-b font-semibold"
            style={{ borderColor: "var(--kf-border)" }}
          >
            <Icon name="settings" size={14} style={{ color: "var(--kf-accent)" }} />
            <span>{t("settings.title")}</span>
          </div>

          {/* Tabs */}
          <nav className="flex-1 py-1">
            {TABS.map(({ id, label, icon, ...rest }) => {
              const disabled = (rest as { disabled?: boolean }).disabled;
              return (
                <button
                  key={id}
                  onClick={() => { if (!disabled) setActiveTab(id); }}
                  disabled={disabled}
                  aria-current={activeTab === id ? "page" : undefined}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors disabled:cursor-not-allowed"
                  // 選択中の項目は一覧・ツリーと同じ選択トークンで塗る。
                  // アクセントを文字色に使うと、淡いアクセント（ユーザー定義テーマ・
                  // OS アクセント連動）で沈む。bg-tertiary の上ではダーク系 dark で
                  // 3.44:1、catppuccin では 2.39:1 しか無く、17 テーマ中 12 テーマが
                  // 本文の 4.5:1 を割っていた。--kf-sel-bg（アクセントを黒側へ寄せた
                  // 塗り）＋ --kf-sel-fg（白）なら全テーマ 8.9:1 以上になる。
                  style={{
                    backgroundColor: activeTab === id ? "var(--kf-sel-bg)" : undefined,
                    color: disabled
                      ? "var(--kf-text-muted)"
                      : activeTab === id
                      ? "var(--kf-sel-fg)"
                      : "var(--kf-text-secondary)",
                    // 選択・非選択で幅を揃えて、切り替えでラベルがずれないようにする
                    borderLeft: "2px solid transparent",
                    opacity: disabled ? 0.45 : 1,
                  }}
                >
                  <Icon name={icon} size={16} />
                  {label}
                </button>
              );
            })}
          </nav>

          {/* Close */}
          <div className="px-3 py-2 border-t" style={{ borderColor: "var(--kf-border)" }}>
            <button aria-label={t("common.close")}
              onClick={onClose}
              className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded opacity-60 hover:opacity-100"
              style={{ border: "1px solid var(--kf-border)" }}
            >
              <Icon name="close" size={12} />
              {t("common.close")}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {activeTab === "theme" && (
            <>
              {/* Quick theme selector */}
              <div
                className="flex flex-col gap-2 px-4 py-3 border-b shrink-0"
                style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
              >
                <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>{t("settings.themePresets")}</span>
                <div className="flex gap-3 flex-wrap items-start">
                  {/* システム */}
                  <ThemeCard
                    name={t("settings.themeSystem")}
                    vars={{
                      "--kf-bg-primary":   "#282828",
                      "--kf-bg-secondary": "#CCCCCC",
                      "--kf-bg-tertiary":  "#999999",
                      "--kf-accent":       "#888888",
                    }}
                    selected={themeId === "system"}
                    onSelect={() => setTheme("system")}
                  />
                  {THEMES.map((th) => (
                    <ThemeCard
                      key={th.id}
                      name={th.name}
                      vars={th.vars}
                      selected={themeId === th.id}
                      onSelect={() => setTheme(th.id)}
                    />
                  ))}
                  {userPresets.map((p) => (
                    <ThemeCard
                      key={p.id}
                      name={p.name}
                      vars={p.vars}
                      selected={themeId === p.id}
                      onSelect={() => { setTheme(p.id); applyTheme(p.id); }}
                      onDelete={() => {
                        const next = loadUserPresets().filter((x) => x.id !== p.id);
                        saveUserPresets(next);
                        setUserPresets(next);
                        if (themeId === p.id) { setTheme("shirube-dark"); applyTheme("shirube-dark"); }
                      }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-hidden">
                <ThemeEditor onClose={onClose} embedded />
              </div>
            </>
          )}

          {activeTab === "keybindings" && (
            <div className="flex-1 overflow-hidden">
              <KeybindingSettings onClose={onClose} embedded />
            </div>
          )}

          {/* 一般: アプリ情報・言語・アップデート・フィードバック */}
          {activeTab === "general" && (
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
              {/* アプリ情報 */}
              <div>
                <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                  {t("settings.sectionAbout")}
                </div>
                <div
                  className="flex items-center gap-4 rounded p-4"
                  style={{ border: "1px solid var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
                >
                  <Icon name="folder_managed" size={34} style={{ color: "var(--kf-accent)" }} />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold" style={{ color: "var(--kf-text-primary)", fontSize: "1.05rem" }}>
                      Shirube-Filer
                    </span>
                    <span style={{ color: "var(--kf-text-muted)", fontSize: "0.85rem" }}>
                      {t("settings.aboutVersion", { version: appVersion || "—" })}
                    </span>
                    <span className="flex items-center gap-3" style={{ fontSize: "0.85rem" }}>
                      <button
                        onClick={() => openUrl("https://shirube-filer.ynaoak.dev/").catch(() => {})}
                        className="hover:underline"
                        style={{ color: "var(--kf-accent)" }}
                      >
                        {t("settings.aboutWebsite")}
                      </button>
                      <button
                        onClick={() => openUrl("https://github.com/ynaoak/shirube-filer/blob/main/LICENSING.md").catch(() => {})}
                        className="hover:underline"
                        style={{ color: "var(--kf-accent)" }}
                      >
                        {t("settings.aboutLicenses")}
                      </button>
                    </span>
                  </div>
                </div>
              </div>
              {/* 言語 */}
              <div>
                <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                  {t("settings.sectionLanguage")}
                </div>
                <div className="flex gap-4">
                  {(["ja", "en"] as Language[]).map((lang) => (
                    <label key={lang} className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="radio"
                        name="language"
                        value={lang}
                        checked={uiSettings.language === lang}
                        onChange={() => setUiSettings({ language: lang })}
                      />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t(`language.${lang}`)}</span>
                    </label>
                  ))}
                </div>
              </div>
              {/* アップデート（Direct 版のみ。ストア版はストアが更新を配信） */}
              {HAS_UPDATER && (
                <div>
                  <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                    {t("settings.sectionUpdate")}
                  </div>
                  <UpdateChecker />
                </div>
              )}
              {/* フィードバック */}
              <div>
                <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                  {t("settings.sectionFeedback")}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => openUrl(FEEDBACK_URL).catch(() => {})}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded"
                    style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
                  >
                    <Icon name="feedback" size={14} />
                    {t("settings.openFeedback")}
                  </button>
                  <span style={{ color: "var(--kf-text-muted)", fontSize: "0.85rem" }}>
                    {t("settings.feedbackHint")}
                  </span>
                </div>
              </div>
            </div>
          )}

          {activeTab === "display" && (() => {
            return (
              <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
                {/* ファイル表示 */}
                <div>
                  <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                    {t("settings.sectionFileDisplay")}
                  </div>
                  <div className="flex flex-col gap-3">
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Toggle on={uiSettings.showHiddenFiles} onToggle={() => setUiSettings({ showHiddenFiles: !uiSettings.showHiddenFiles })} />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t("settings.showHiddenFiles")}</span>
                    </label>
                    {/* アイコンセット: 内蔵 Material / OS シェル（Windows エクスプローラーと同じ絵柄） */}
                    <label className="flex items-center gap-3 select-none">
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t("settings.iconSet")}</span>
                      <select
                        value={uiSettings.iconSet}
                        onChange={(e) => setUiSettings({ iconSet: e.target.value as "material" | "dimensional" | "system" })}
                        className="px-2 py-1 rounded text-xs"
                        style={{
                          backgroundColor: "var(--kf-bg-tertiary)",
                          color: "var(--kf-text-primary)",
                          border: "1px solid var(--kf-border)",
                        }}
                      >
                        <option value="material">{t("settings.iconSetMaterial")}</option>
                        <option value="dimensional">{t("settings.iconSetDimensional")}</option>
                        <option value="system">{t("settings.iconSetSystem")}</option>
                      </select>
                      <span style={{ color: "var(--kf-text-muted)", fontSize: 11 }}>
                        {t("settings.iconSetHint")}
                      </span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Toggle on={uiSettings.showColumnDividers} onToggle={() => setUiSettings({ showColumnDividers: !uiSettings.showColumnDividers })} />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t("settings.showColumnDividers")}</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Toggle on={uiSettings.showRowDividers} onToggle={() => setUiSettings({ showRowDividers: !uiSettings.showRowDividers })} />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t("settings.showRowDividers")}</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Toggle on={uiSettings.autoShowPreview} onToggle={() => setUiSettings({ autoShowPreview: !uiSettings.autoShowPreview })} />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t("settings.autoShowPreview")}</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Toggle on={uiSettings.autoShowTaskPanel} onToggle={() => setUiSettings({ autoShowTaskPanel: !uiSettings.autoShowTaskPanel })} />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t("settings.autoShowTaskPanel")}</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Toggle on={uiSettings.autoCalcDirSizes} onToggle={() => setUiSettings({ autoCalcDirSizes: !uiSettings.autoCalcDirSizes })} />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t("settings.autoCalcDirSizes")}</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <Toggle
                        on={uiSettings.followOsAccent}
                        onToggle={() => {
                          const next = !uiSettings.followOsAccent;
                          setUiSettings({ followOsAccent: next });
                          // OFF にしたら現在テーマを再適用して accent を戻す。ON なら OS 色を被せる。
                          if (next) maybeApplyOsAccent();
                          else applyTheme((localStorage.getItem("shirube-theme") as Parameters<typeof applyTheme>[0]) ?? "shirube-dark");
                        }}
                      />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{t("settings.followOsAccent")}</span>
                    </label>
                  </div>
                </div>

                {/* ファイルの関連付け */}
                <div>
                  <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                    {t("settings.sectionFileAssoc")}
                  </div>
                  <p className="text-xs mb-3" style={{ color: "var(--kf-text-muted)" }}>
                    {t("settings.fileAssocDesc")}
                  </p>
                  <div className="flex flex-col gap-2">
                    {/* アプリごとにグループ化して表示 */}
                    {Object.entries(
                      Object.entries(uiSettings.fileAssociations).reduce<Record<string, string[]>>(
                        (acc, [ext, ap]) => { (acc[ap] ??= []).push(ext); return acc; },
                        {}
                      )
                    ).map(([appPath, exts]) => (
                      <AppAssociationGroup
                        key={appPath}
                        appPath={appPath}
                        exts={exts}
                        onAppChange={(newPath) => {
                          const next = { ...uiSettings.fileAssociations };
                          for (const ext of exts) { delete next[ext]; next[ext] = newPath; }
                          setUiSettings({ fileAssociations: next });
                        }}
                        onAddExt={(ext) => {
                          setUiSettings({ fileAssociations: { ...uiSettings.fileAssociations, [ext]: appPath } });
                        }}
                        onRemoveExt={(ext) => {
                          const next = { ...uiSettings.fileAssociations };
                          delete next[ext];
                          setUiSettings({ fileAssociations: next });
                        }}
                        onDeleteGroup={() => {
                          const next = { ...uiSettings.fileAssociations };
                          for (const ext of exts) delete next[ext];
                          setUiSettings({ fileAssociations: next });
                        }}
                      />
                    ))}
                    {/* 新規追加行 */}
                    <NewAssociationRow onAdd={(exts, appPath) => {
                      const next = { ...uiSettings.fileAssociations };
                      for (const ext of exts) next[ext] = appPath;
                      setUiSettings({ fileAssociations: next });
                    }} />
                  </div>
                </div>

                {/* ターミナル */}
                <div>
                  <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                    {t("settings.sectionTerminal")}
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-xs" style={{ color: "var(--kf-text-muted)" }}>
                      {t("settings.terminalShellLabel")}
                    </label>

                    {/* 検出済みシェルのドロップダウン */}
                    <div>
                      <div className="text-xs mb-1" style={{ color: "var(--kf-text-muted)" }}>
                        {t("settings.terminalShellDetected")}
                      </div>
                      <select
                        value={(() => {
                          if (!uiSettings.terminalShell) return "__default__";
                          if (detectedShells?.some((s) => s.path === uiSettings.terminalShell)) {
                            return uiSettings.terminalShell;
                          }
                          return "__custom__";
                        })()}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "__default__") setUiSettings({ terminalShell: "" });
                          else if (v !== "__custom__") setUiSettings({ terminalShell: v });
                        }}
                        className="w-full rounded px-3 py-1.5 text-xs outline-none"
                        style={{
                          backgroundColor: "var(--kf-bg-primary)",
                          border: "1px solid var(--kf-border)",
                          color: "var(--kf-text-primary)",
                        }}
                      >
                        <option value="__default__">
                          {t("settings.terminalShellDetectedDefault")}
                        </option>
                        {detectedShells === null ? (
                          <option disabled>{t("settings.terminalShellDetecting")}</option>
                        ) : (
                          detectedShells.map((s) => (
                            <option key={s.path} value={s.path}>{s.name}</option>
                          ))
                        )}
                        {/* 現在値が検出リストにない場合のみ「カスタム」を表示 */}
                        {uiSettings.terminalShell &&
                          detectedShells !== null &&
                          !detectedShells.some((s) => s.path === uiSettings.terminalShell) && (
                            <option value="__custom__">{t("settings.terminalShellCustom")}</option>
                          )}
                      </select>
                    </div>

                    {/* カスタムパス入力（常に表示） */}
                    <div>
                      <div className="text-xs mb-1" style={{ color: "var(--kf-text-muted)" }}>
                        {t("settings.terminalShellCustomPath")}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={uiSettings.terminalShell}
                          onChange={(e) => setUiSettings({ terminalShell: e.target.value })}
                          placeholder={t("settings.terminalShellPlaceholder")}
                          className="flex-1 rounded px-3 py-1.5 text-xs outline-none font-mono"
                          style={{
                            backgroundColor: "var(--kf-bg-primary)",
                            border: "1px solid var(--kf-border)",
                            color: "var(--kf-text-primary)",
                          }}
                        />
                        <button
                          onClick={async () => {
                            const selected = await open({
                              multiple: false,
                              directory: false,
                              filters: exeFilters(),
                            });
                            if (typeof selected === "string") {
                              setUiSettings({ terminalShell: selected });
                            }
                          }}
                          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs shrink-0 hover:opacity-80"
                          style={{
                            border: "1px solid var(--kf-border)",
                            color: "var(--kf-text-secondary)",
                            backgroundColor: "var(--kf-bg-primary)",
                          }}
                          title={t("settings.selectFile")}
                        >
                          <Icon name="folder_open" size={13} />
                          {t("settings.browse")}
                        </button>
                      </div>
                    </div>

                    <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>
                      {t("settings.terminalShellHint")}
                    </span>
                  </div>
                </div>
                {settingsFilePath && (
                  <div>
                    <div className="font-semibold mb-2" style={{ color: "var(--kf-text-primary)" }}>
                      {t("settings.sectionSettingsFile")}
                    </div>
                    <p className="text-xs mb-2" style={{ color: "var(--kf-text-muted)" }}>
                      {t("settings.settingsFileDesc")}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <div
                        className="flex-1 text-xs font-mono px-3 py-2 rounded select-all"
                        style={{
                          backgroundColor: "var(--kf-bg-primary)",
                          border: "1px solid var(--kf-border)",
                          color: "var(--kf-text-secondary)",
                          wordBreak: "break-all",
                        }}
                      >
                        {settingsFilePath}
                      </div>
                      <button
                        onClick={() => revealItemInDir(settingsFilePath).catch(() => {})}
                        className="flex items-center gap-1 px-2 py-1.5 rounded text-xs shrink-0 hover:opacity-80"
                        style={{
                          border: "1px solid var(--kf-border)",
                          color: "var(--kf-text-secondary)",
                          backgroundColor: "var(--kf-bg-primary)",
                        }}
                        title={t("settings.openInExplorer")}
                      >
                        <Icon name="folder_open" size={13} />
                        {t("settings.browse")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {activeTab === "layout" && (
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
              <div>
                <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                  {t("settings.sectionLayoutManagement")}
                </div>
                <div className="flex items-center gap-3 mb-4">
                  <span style={{ color: "var(--kf-text-muted)" }}>{t("settings.layoutFormat")}</span>
                  <select
                    value={layoutFormat}
                    onChange={(e) => setLayoutFormat(e.target.value as LayoutFormat)}
                    className="rounded px-2 py-1 text-xs border"
                    style={{
                      backgroundColor: "var(--kf-bg-tertiary)",
                      color: "var(--kf-text-primary)",
                      borderColor: "var(--kf-border)",
                    }}
                  >
                    <option value="json">JSON</option>
                    <option value="yaml">YAML</option>
                    <option value="xml">XML</option>
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={handleLayoutSave}
                    className="flex items-center gap-2 px-3 py-2 rounded text-xs"
                    style={{ backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-primary)", border: "1px solid var(--kf-border)" }}
                  >
                    <Icon name="save" size={14} />
                    {t("common.save")}
                  </button>
                  <button
                    onClick={handleLayoutLoad}
                    className="flex items-center gap-2 px-3 py-2 rounded text-xs"
                    style={{ backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-primary)", border: "1px solid var(--kf-border)" }}
                  >
                    <Icon name="folder_open" size={14} />
                    {t("settings.import")}
                  </button>
                  <button
                    onClick={handleLayoutExport}
                    className="flex items-center gap-2 px-3 py-2 rounded text-xs"
                    style={{ backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-primary)", border: "1px solid var(--kf-border)" }}
                  >
                    <Icon name="upload" size={14} />
                    {t("settings.export")}
                  </button>
                </div>
                {layoutStatus && (
                  <p className="mt-3 text-xs" style={{ color: "var(--kf-text-muted)" }}>{layoutStatus}</p>
                )}
              </div>

              {/* 設定バックアップ */}
              <div>
                <div className="font-semibold mb-3" style={{ color: "var(--kf-text-primary)" }}>
                  {t("settings.sectionSettingsBackup")}
                </div>
                <p className="mb-3 text-xs" style={{ color: "var(--kf-text-muted)" }}>
                  {t("settings.settingsBackupDesc")}
                </p>
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={handleSettingsExport}
                    className="flex items-center gap-2 px-3 py-2 rounded text-xs"
                    style={{ backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-primary)", border: "1px solid var(--kf-border)" }}
                  >
                    <Icon name="upload" size={14} />
                    {t("settings.export")}
                  </button>
                  <button
                    onClick={handleSettingsImport}
                    className="flex items-center gap-2 px-3 py-2 rounded text-xs"
                    style={{ backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-primary)", border: "1px solid var(--kf-border)" }}
                  >
                    <Icon name="folder_open" size={14} />
                    {t("settings.import")}
                  </button>
                </div>
                {settingsStatus && (
                  <p className="mt-3 text-xs" style={{ color: "var(--kf-text-muted)" }}>{settingsStatus}</p>
                )}
              </div>
            </div>
          )}

          {activeTab === "preview" && (
            <div className="flex-1 overflow-y-auto flex flex-col">
              {/* プレビューの配色（テキスト / マークダウン） */}
              <div className="p-6 pb-2 flex flex-col gap-4">
                <div>
                  <div className="font-semibold mb-1" style={{ color: "var(--kf-text-primary)" }}>{t("settings.previewThemeTitle")}</div>
                  <p className="text-xs mb-3" style={{ color: "var(--kf-text-muted)" }}>{t("settings.previewThemeDesc")}</p>
                  <div className="flex flex-col gap-3">
                    <label className="flex items-center gap-3">
                      <span className="text-xs w-56" style={{ color: "var(--kf-text-secondary)" }}>{t("settings.codePreviewTheme")}</span>
                      <select
                        value={uiSettings.codePreviewTheme}
                        onChange={(e) => setUiSettings({ codePreviewTheme: e.target.value as UiSettings["codePreviewTheme"] })}
                        className="bg-transparent outline-none rounded px-2 py-1 text-xs"
                        style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
                      >
                        <option value="dark">{t("settings.previewThemeDark")}</option>
                        <option value="app">{t("settings.previewThemeApp")}</option>
                        <option value="light">{t("settings.previewThemeLight")}</option>
                        {BUILTIN_THEME_IDS.filter((id) => id !== "dark-plus" && id !== "light-plus").map((id) => (
                          <option key={id} value={id}>{t(BUILTIN_THEME_LABEL_KEYS[id] ?? id)}</option>
                        ))}
                        {uiSettings.customCodeTheme && (
                          <option value="custom">{t("settings.previewThemeCustom")}</option>
                        )}
                      </select>
                      <button className="kf-btn kf-btn-secondary" onClick={handleImportVsCodeTheme}>
                        <Icon name="download" size={13} />
                        {t("settings.importVsCodeTheme")}
                      </button>
                      {uiSettings.customCodeTheme && (
                        <button className="kf-btn kf-btn-danger" onClick={handleRemoveCustomTheme}>
                          <Icon name="restart_alt" size={13} />
                          {t("settings.customThemeRemove")}
                        </button>
                      )}
                      {themeImportStatus && (
                        <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>{themeImportStatus}</span>
                      )}
                    </label>
                    <label className="flex items-center gap-3">
                      <span className="text-xs w-56" style={{ color: "var(--kf-text-secondary)" }}>{t("settings.markdownPreviewTheme")}</span>
                      <select
                        value={uiSettings.markdownPreviewTheme}
                        onChange={(e) => setUiSettings({ markdownPreviewTheme: e.target.value as "app" | "dark" })}
                        className="bg-transparent outline-none rounded px-2 py-1 text-xs"
                        style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
                      >
                        <option value="app">{t("settings.previewThemeApp")}</option>
                        <option value="dark">{t("settings.previewThemeDark")}</option>
                      </select>
                    </label>
                  </div>
                </div>
              </div>
              {/* シンタックスハイライトのトークン別カスタム色 */}
              <div className="px-6 pb-4">
                <div className="font-semibold mb-1" style={{ color: "var(--kf-text-primary)" }}>{t("settings.highlightColorsTitle")}</div>
                <p className="text-xs mb-3" style={{ color: "var(--kf-text-muted)" }}>{t("settings.highlightColorsDesc")}</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-3" style={{ maxWidth: 560 }}>
                  {HL_TOKEN_KEYS.map((key) => {
                    const val = uiSettings.codeHighlightColors[key] ?? "";
                    const set = (v: string | null) => {
                      const next = { ...uiSettings.codeHighlightColors };
                      if (v) next[key] = v; else delete next[key];
                      setUiSettings({ codeHighlightColors: next });
                    };
                    return (
                      <label key={key} className="flex items-center gap-2 text-xs">
                        <span className="w-28" style={{ color: "var(--kf-text-secondary)" }}>{t(`settings.hlToken_${key}`)}</span>
                        <input
                          type="color"
                          value={val || "#888888"}
                          onChange={(e) => set(e.target.value)}
                          style={{ width: 26, height: 20, padding: 0, border: "1px solid var(--kf-border)", borderRadius: 4, background: "transparent", cursor: "pointer" }}
                        />
                        <span className="font-mono" style={{ color: val ? "var(--kf-text-primary)" : "var(--kf-text-muted)", fontSize: 10, width: 56 }}>
                          {val || t("settings.hlTokenDefault")}
                        </span>
                        {val && (
                          <button onClick={() => set(null)} title={t("common.remove")} className="opacity-60 hover:opacity-100 flex items-center">
                            <Icon name="close" size={11} />
                          </button>
                        )}
                      </label>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <button className="kf-btn kf-btn-secondary" onClick={handleExportHighlight}>
                    <Icon name="upload" size={13} />
                    {t("settings.hlExport")}
                  </button>
                  <button className="kf-btn kf-btn-secondary" onClick={handleImportHighlight}>
                    <Icon name="download" size={13} />
                    {t("settings.hlImport")}
                  </button>
                  {Object.keys(uiSettings.codeHighlightColors).length > 0 && (
                    <button className="kf-btn kf-btn-danger" onClick={() => setUiSettings({ codeHighlightColors: {} })}>
                      <Icon name="restart_alt" size={13} />
                      {t("settings.hlReset")}
                    </button>
                  )}
                  {hlStatus && <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>{hlStatus}</span>}
                </div>
              </div>
              <PreviewExtSettings
                config={uiSettings.previewExtConfig}
                onChange={(next) => setUiSettings({ previewExtConfig: next })}
              />
            </div>
          )}

          {activeTab === "data" && (
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8">

              {/* ── エクスポート ───────────────────────────────── */}
              <div>
                <div className="font-semibold mb-1" style={{ color: "var(--kf-text-primary)" }}>{t("settings.dataExportTitle")}</div>
                <p className="text-xs mb-3" style={{ color: "var(--kf-text-muted)" }}>
                  {t("settings.dataExportDesc")}
                </p>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {EXPORT_SECTIONS.map(({ key, label, icon }) => (
                    <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={exportSections[key]}
                        onChange={(e) => setExportSections((prev) => ({ ...prev, [key]: e.target.checked }))}
                        className="rounded"
                        style={{ accentColor: "var(--kf-accent)" }}
                      />
                      <Icon name={icon} size={15} style={{ color: "var(--kf-text-muted)" }} />
                      <span style={{ color: "var(--kf-text-secondary)" }}>{label}</span>
                    </label>
                  ))}
                </div>
                <button
                  onClick={handleDataExport}
                  disabled={!Object.values(exportSections).some(Boolean)}
                  className="flex items-center gap-2 px-4 py-2 rounded text-xs font-semibold disabled:opacity-40"
                  style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
                >
                  <Icon name="upload" size={14} />
                  {t("settings.dataExportButton")}
                </button>
                {exportStatus && (
                  <p className="mt-2 text-xs break-all" style={{ color: "var(--kf-text-muted)" }}>
                    {exportStatus}
                  </p>
                )}
              </div>

              {/* ── インポート ───────────────────────────────── */}
              <div>
                <div className="font-semibold mb-1" style={{ color: "var(--kf-text-primary)" }}>{t("settings.dataImportTitle")}</div>
                <p className="text-xs mb-3" style={{ color: "var(--kf-text-muted)" }}>
                  {t("settings.dataImportDesc")}
                </p>

                {/* D&D ゾーン */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setImportDragOver(true); }}
                  onDragLeave={() => setImportDragOver(false)}
                  onDrop={handleImportDrop}
                  className="rounded flex flex-col items-center justify-center gap-2 py-8 mb-3 transition-colors"
                  style={{
                    border: `2px dashed ${importDragOver ? "var(--kf-accent)" : "var(--kf-border)"}`,
                    backgroundColor: importDragOver ? "color-mix(in srgb, var(--kf-accent) 8%, transparent)" : "var(--kf-bg-secondary)",
                  }}
                >
                  <Icon name="upload_file" size={28} style={{ color: importDragOver ? "var(--kf-accent)" : "var(--kf-text-muted)" }} />
                  <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>{t("settings.dataDropHint")}</span>
                  <button
                    onClick={handleImportFilePick}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs hover:opacity-80"
                    style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)", backgroundColor: "var(--kf-bg-primary)" }}
                  >
                    <Icon name="folder_open" size={13} />
                    {t("settings.dataSelectFile")}
                  </button>
                </div>

                {/* プレビュー */}
                {importPreview && (
                  <div
                    className="rounded p-3 mb-3 flex flex-col gap-1.5"
                    style={{ backgroundColor: "var(--kf-bg-secondary)", border: "1px solid var(--kf-border)" }}
                  >
                    <div className="text-xs font-semibold mb-1" style={{ color: "var(--kf-text-primary)" }}>{t("settings.dataImportPreviewTitle")}</div>
                    {EXPORT_SECTIONS.filter(({ key }) => importPreview[key] != null).map(({ key, label, icon }) => (
                      <div key={key} className="flex items-center gap-1.5 text-xs" style={{ color: "var(--kf-text-secondary)" }}>
                        <Icon name={icon} size={15} style={{ color: "var(--kf-accent)" }} />
                        {label}
                      </div>
                    ))}
                    {EXPORT_SECTIONS.every(({ key }) => importPreview[key] == null) && (
                      <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>{t("settings.dataNoMatchingData")}</span>
                    )}
                  </div>
                )}

                {importStatus && (
                  <p className="mb-2 text-xs" style={{ color: "var(--kf-error)" }}>{importStatus}</p>
                )}

                <button
                  onClick={handleApplyImport}
                  disabled={!importPreview || EXPORT_SECTIONS.every(({ key }) => importPreview[key] == null)}
                  className="flex items-center gap-2 px-4 py-2 rounded text-xs font-semibold disabled:opacity-40"
                  style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
                >
                  <Icon name="download" size={14} />
                  {t("settings.dataImportApply")}
                </button>
              </div>

              {/* ── 同期履歴 ───────────────────────────────── */}
              <div className="pt-2" style={{ borderTop: "1px solid var(--kf-border)" }}>
                <div className="font-semibold mb-1 mt-4" style={{ color: "var(--kf-text-primary)" }}>{t("settings.syncHistoryTitle")}</div>
                <p className="text-xs mb-3" style={{ color: "var(--kf-text-muted)" }}>
                  {t("settings.syncHistoryDesc")}
                </p>
                <label className="flex items-center gap-2 mb-3 text-xs" style={{ color: "var(--kf-text-secondary)" }}>
                  {t("settings.syncHistoryLimit")}
                  <input
                    type="number"
                    min={100}
                    max={1000000}
                    step={100}
                    value={uiSettings.syncHistoryLimit}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setUiSettings({ syncHistoryLimit: Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10000 });
                    }}
                    className="w-24 px-2 py-1 rounded outline-none"
                    style={{ border: "1px solid var(--kf-border)", backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-primary)" }}
                  />
                  <span style={{ color: "var(--kf-text-muted)" }}>{t("settings.syncHistoryLimitUnit")}</span>
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="datetime-local"
                    value={historyCutoff}
                    onChange={(e) => setHistoryCutoff(e.target.value)}
                    className="px-2 py-1 rounded outline-none text-xs"
                    style={{ border: "1px solid var(--kf-border)", backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-primary)" }}
                  />
                  <button
                    onClick={handleDiscardHistory}
                    disabled={!historyCutoff}
                    className="flex items-center gap-2 px-4 py-2 rounded text-xs font-semibold disabled:opacity-40"
                    style={{ border: "1px solid var(--kf-error)", color: "var(--kf-error)", backgroundColor: "transparent" }}
                  >
                    <Icon name="delete_history" size={14} />
                    {t("settings.syncHistoryDiscardButton")}
                  </button>
                </div>
                {historyStatus && (
                  <p className="mt-2 text-xs break-all" style={{ color: "var(--kf-text-muted)" }}>{historyStatus}</p>
                )}
              </div>

              {/* ── すべてのデータを削除（初期化）───────────────── */}
              <div className="pt-2" style={{ borderTop: "1px solid var(--kf-border)" }}>
                <div className="font-semibold mb-1 mt-4" style={{ color: "var(--kf-error)" }}>{t("settings.dataClearTitle")}</div>
                <p className="text-xs mb-3" style={{ color: "var(--kf-text-muted)" }}>
                  {t("settings.dataClearDesc")}
                </p>
                <button
                  onClick={handleClearAllData}
                  disabled={clearing}
                  className="flex items-center gap-2 px-4 py-2 rounded text-xs font-semibold disabled:opacity-40"
                  style={{ backgroundColor: "var(--kf-error)", color: "#fff" }}
                >
                  <Icon name="delete_forever" size={14} />
                  {t("settings.dataClearButton")}
                </button>
                {clearStatus && (
                  <p className="mt-2 text-xs break-all" style={{ color: "var(--kf-text-muted)" }}>{clearStatus}</p>
                )}
              </div>
            </div>
          )}

          {activeTab === "addon" && (
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {/* ヘッダー操作 */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleAddonInstall}
                  disabled={addonInstalling}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded disabled:opacity-40"
                  style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
                >
                  <Icon name="install_desktop" size={13} />
                  {addonInstalling ? t("settings.addonInstalling") : t("settings.addonInstallFromZip")}
                </button>
                <button
                  onClick={() => addonCtx?.reload()}
                  className="flex items-center gap-1 text-xs px-2 py-1.5 rounded opacity-60 hover:opacity-100"
                  style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)" }}
                  title={t("settings.addonReload")}
                >
                  <Icon name="refresh" size={13} />
                </button>
              </div>
              {addonInstallError && (
                <p className="text-xs" style={{ color: "var(--kf-error)" }}>{addonInstallError}</p>
              )}
              {(!addonCtx || addonCtx.addons.length === 0) && (
                <p className="text-center text-xs py-8" style={{ color: "var(--kf-text-muted)" }}>
                  {t("settings.addonNone")}
                  <br />
                  <span style={{ opacity: 0.6 }}>{t("settings.addonNoneHint")}</span>
                </p>
              )}
              {addonCtx?.addons.map((addon) => (
                <div
                  key={addon.meta.id}
                  className="flex items-start gap-3 p-3 rounded border"
                  style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium truncate" style={{ color: "var(--kf-text-primary)" }}>
                        {addon.meta.name}
                      </span>
                      <span className="text-xs" style={{ color: "var(--kf-text-muted)" }}>
                        v{addon.meta.version}
                      </span>
                    </div>
                    <p className="text-xs mt-0.5 truncate" style={{ color: "var(--kf-text-secondary)" }}>
                      {addon.meta.description}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--kf-text-muted)" }}>
                      {addon.meta.author} · {addon.meta.license}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 mt-0.5">
                    <button
                      onClick={() => handleAddonUninstall(addon.meta.id, addon.meta.name)}
                      disabled={addonUninstallingId === addon.meta.id}
                      className="flex items-center opacity-40 hover:opacity-80 disabled:opacity-20"
                      title={t("addonManager.uninstall")}
                      style={{ color: "var(--kf-error)" }}
                    >
                      <Icon name="delete" size={14} />
                    </button>
                    <button
                      onClick={() => addonCtx.setEnabled(addon.meta.id, !addon.enabled)}
                      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                      style={{ backgroundColor: addon.enabled ? "var(--kf-accent)" : "var(--kf-bg-tertiary)" }}
                      title={addon.enabled ? t("addonManager.disable") : t("addonManager.enable")}
                    >
                      <span
                        className="inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform"
                        style={{ transform: addon.enabled ? "translateX(18px)" : "translateX(2px)" }}
                      />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
  );

  if (standalone) {
    return (
      <div className="fixed inset-0" style={{ backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-primary)" }}>
        {inner}
      </div>
    );
  }

  return (
    <div
      className="kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {inner}
    </div>
  );
}

// ---- プレビュー拡張子設定 ----

type PreviewTypeConfig = Exclude<PreviewType, "auto">;

const PREVIEW_TYPE_META_BASE: { type: PreviewTypeConfig; icon: string; placeholder: string }[] = [
  { type: "text",  icon: "code",            placeholder: "txt, log, *rc, *ignore" },
  { type: "image", icon: "image",           placeholder: "jpg, png, webp, avif" },
  { type: "video", icon: "videocam",        placeholder: "mp4, mkv, avi" },
  { type: "audio", icon: "audio_file",      placeholder: "mp3, flac, aac" },
  { type: "pdf",   icon: "picture_as_pdf",  placeholder: "pdf" },
  { type: "none",  icon: "block",           placeholder: "exe, dll, *tmp" },
];

function PreviewExtSettings({
  config,
  onChange,
}: {
  config: Record<string, PreviewType>;
  onChange: (next: Record<string, PreviewType>) => void;
}) {
  const { t } = useTranslation();
  const PREVIEW_TYPE_META: { type: PreviewTypeConfig; label: string; icon: string; placeholder: string }[] = [
    { ...PREVIEW_TYPE_META_BASE[0], label: t("settings.previewTypeText") },
    { ...PREVIEW_TYPE_META_BASE[1], label: t("settings.previewTypeImage") },
    { ...PREVIEW_TYPE_META_BASE[2], label: t("settings.previewTypeVideo") },
    { ...PREVIEW_TYPE_META_BASE[3], label: t("settings.previewTypeAudio") },
    { ...PREVIEW_TYPE_META_BASE[4], label: "PDF" },
    { ...PREVIEW_TYPE_META_BASE[5], label: t("settings.previewTypeNone") },
  ];

  // draft[type] = comma-separated string being edited
  const [draft, setDraft] = useState<Record<PreviewTypeConfig, string>>(() => {
    const init = {} as Record<PreviewTypeConfig, string>;
    for (const { type } of PREVIEW_TYPE_META_BASE) {
      init[type] = Object.entries(config)
        .filter(([, t]) => t === type)
        .map(([e]) => e)
        .sort()
        .join(", ");
    }
    return init;
  });

  // Sync draft when external config changes (e.g. settings import)
  useEffect(() => {
    setDraft(() => {
      const next = {} as Record<PreviewTypeConfig, string>;
      for (const { type } of PREVIEW_TYPE_META_BASE) {
        next[type] = Object.entries(config)
          .filter(([, t]) => t === type)
          .map(([e]) => e)
          .sort()
          .join(", ");
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(config)]);

  const commit = (type: PreviewTypeConfig, raw: string) => {
    const exts = parseExts(raw);
    // Remove all entries of this type, then add fresh ones
    const next: Record<string, PreviewType> = Object.fromEntries(
      Object.entries(config).filter(([, t]) => t !== type)
    );
    for (const ext of exts) next[ext] = type;
    onChange(next);
    // Normalize the draft to sorted deduplicated form
    setDraft((prev) => ({ ...prev, [type]: exts.join(", ") }));
  };

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-3">
      <div>
        <div className="font-semibold mb-1" style={{ color: "var(--kf-text-primary)" }}>
          {t("settings.previewExtTitle")}
        </div>
        <p className="text-xs" style={{ color: "var(--kf-text-muted)" }}>
          {t("settings.previewExtDesc")}
          <code style={{ margin: "0 3px", opacity: 0.8 }}>*</code>
          (<code style={{ margin: "0 3px", opacity: 0.8 }}>*rc</code>
          ,
          <code style={{ margin: "0 3px", opacity: 0.8 }}>log*</code>
          ,
          <code style={{ margin: "0 3px", opacity: 0.8 }}>*</code>)
        </p>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {PREVIEW_TYPE_META.map(({ type, label, icon, placeholder }) => (
          <div
            key={type}
            className="flex flex-col gap-1.5 rounded-lg p-3"
            style={{
              backgroundColor: "var(--kf-bg-secondary)",
              border: "1px solid var(--kf-border)",
            }}
          >
            <div className="flex items-center gap-1.5" style={{ color: "var(--kf-text-secondary)" }}>
              <Icon name={icon} size={13} />
              <span className="font-semibold text-xs">{label}</span>
            </div>
            <textarea
              value={draft[type]}
              onChange={(e) => setDraft((prev) => ({ ...prev, [type]: e.target.value }))}
              onBlur={(e) => commit(type, e.target.value)}
              placeholder={placeholder}
              rows={6}
              className="rounded px-2 py-1.5 text-xs font-mono outline-none resize-none"
              style={{
                backgroundColor: "var(--kf-bg-primary)",
                border: "1px solid var(--kf-border)",
                color: "var(--kf-text-primary)",
                lineHeight: 1.6,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

