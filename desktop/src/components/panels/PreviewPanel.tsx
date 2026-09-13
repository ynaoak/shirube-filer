import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { APP_EVENTS } from "../../lib/appEvents";
import { hlColorsToStyle } from "../../lib/highlightTheme";
import { highlightWithShiki, shikiLangForExt } from "../../lib/shikiHighlighter";
import { useAppIsDark } from "../../hooks/useAppIsDark";
import { marked } from "marked";
import DOMPurify from "dompurify";
import Icon from "../common/Icon";
import { ExifData, EXIF_EXTS, hasAnyExif, ExifTable } from "../viewers/ExifTable";
import { useUiSettings } from "../../store/uiSettingsStore";
import { formatModCombo } from "../../store/keybindingStore";

// Monaco エディタは重いため、編集モードに入ったときだけ遅延ロードする。
const CodeEditor = lazy(() => import("../viewers/CodeEditor"));

const MIN_WIDTH = 160;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 256;
const LS_KEY = "kf-preview-width";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"]);
const PDF_EXTS = new Set(["pdf"]);
const TEXT_EXTS = new Set([
  "txt", "rs", "ts", "tsx", "js", "jsx", "py", "go", "md", "json",
  "toml", "yaml", "yml", "css", "html", "xml", "sh", "bash", "zsh",
  "c", "cpp", "h", "java", "rb", "php", "swift", "kt",
  "lua", "cs", "fs", "ex", "exs", "erl", "hrl", "hs", "ml", "mli",
  "clj", "cljs", "scala", "dart", "r", "jl", "vim", "tf", "hcl",
  "sql", "graphql", "proto", "svelte", "vue", "astro",
  "gitignore", "dockerignore", "env", "lock", "makefile", "rakefile",
  "procfile", "editorconfig", "eslintrc", "prettierrc", "babelrc",
  "npmrc", "nvmrc", "htaccess",
]);

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", avif: "image/avif",
};

// 拡張子 → Monaco エディタの言語 id（編集モードの CodeEditor 専用。shiki のハイライト
// 言語判定には ../lib/shikiHighlighter の shikiLangForExt を使う）。
const EXT_TO_LANG: Record<string, string> = {
  rs: "rust", ts: "typescript", tsx: "typescript", js: "javascript",
  jsx: "javascript", py: "python", go: "go",
  json: "json", toml: "toml", yaml: "yaml", yml: "yaml",
  css: "css", html: "xml", xml: "xml", sh: "bash", bash: "bash",
  zsh: "bash", c: "c", cpp: "cpp", h: "c", java: "java",
  rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
};

// Configure marked for safe rendering (no external images in CSP)
marked.setOptions({ async: false });

type BlameEntry = { line: number; oid: string; author: string; time: number; message: string };

// EXIF の型・判定・テーブルは ./ExifTable に集約（ImageViewer / QuickPreviewModal と共有）。

/**
 * ワイルドカード（*）を含むパターンと拡張子を照合する。
 * * は任意の文字列にマッチ。
 */
function matchGlob(pattern: string, str: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(str);
}

/**
 * previewExtConfig から拡張子に対応するプレビュータイプを解決する。
 * 優先順位: 完全一致 > ワイルドカード（リテラル文字数が多いほど優先）
 */
function resolvePreviewType(
  config: Record<string, import("../../store/uiSettingsStore").PreviewType>,
  ext: string,
): import("../../store/uiSettingsStore").PreviewType {
  if (!ext) return "auto";
  if (config[ext]) return config[ext];
  const wildcards = Object.keys(config)
    .filter((k) => k.includes("*"))
    .sort((a, b) => b.replace(/\*/g, "").length - a.replace(/\*/g, "").length); // リテラル文字数降順
  for (const pattern of wildcards) {
    if (matchGlob(pattern, ext)) return config[pattern];
  }
  return "auto";
}

type ArchiveEntry = {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
};

// list_archive が対応するアーカイブ判定（zip / tar.gz / tgz）。
function isArchiveFile(ext: string, fileName: string): boolean {
  return ext === "zip" || ext === "tgz" || fileName.toLowerCase().endsWith(".tar.gz");
}

function formatArchiveSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

type Props = {
  filePath: string | null;
  onClose: () => void;
  /** ペインとして全面表示する場合は true。固定幅・左リサイズハンドルを無効化し、
   *  コンテナいっぱい（全幅・全高）に広げる。未指定時は右サイドパネル（固定幅）。 */
  fill?: boolean;
};

export default function PreviewPanel({ filePath, onClose, fill }: Props) {
  const { t } = useTranslation();
  const [{ previewExtConfig, codePreviewTheme, markdownPreviewTheme, codeHighlightColors, customCodeTheme }] = useUiSettings();
  const hlStyle = hlColorsToStyle(codeHighlightColors);
  const appIsDark = useAppIsDark();
  const [content, setContent] = useState<string | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exifData, setExifData] = useState<ExifData | null>(null);
  const [showExif, setShowExif] = useState(false);
  // "highlight" | "markdown" | "plain"
  const [renderMode, setRenderMode] = useState<"highlight" | "markdown" | "plain">("highlight");
  const [width, setWidth] = useState<number>(() => {
    const saved = localStorage.getItem(LS_KEY);
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return isNaN(parsed) ? DEFAULT_WIDTH : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
  });
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const dragStartXRef = useRef<number | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartXRef.current = e.clientX;
    const startWidth = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      if (dragStartXRef.current === null) return;
      const delta = dragStartXRef.current - ev.clientX; // drag left = increase width
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      setWidth(newWidth);
      localStorage.setItem(LS_KEY, String(newWidth));
    };
    const onUp = () => {
      dragStartXRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const fileName = filePath?.split(/[\\/]/).pop() ?? "";
  // ファイル名から拡張子を取得。Dockerfile/.gitignore 等、拡張子なしのファイル名も考慮
  const extRaw = filePath?.split(".").pop()?.toLowerCase() ?? "";
  const ext = extRaw === filePath?.split(/[\\/]/).pop()?.toLowerCase() ? "" : extRaw;
  // 拡張子なし特殊ファイル名
  const bareNames = new Set(["dockerfile", ".gitignore", ".dockerignore", ".env", "makefile", "rakefile", "procfile"]);
  const isSpecialText = bareNames.has(fileName.toLowerCase());

  // ユーザー設定のオーバーライドを優先（ワイルドカード対応）、"auto" はデフォルトロジックにフォールバック
  const extOverride = resolvePreviewType(previewExtConfig, ext);
  const isImage  = extOverride !== "auto" ? extOverride === "image"  : IMAGE_EXTS.has(ext);
  const isVideo  = extOverride !== "auto" ? extOverride === "video"  : VIDEO_EXTS.has(ext);
  const isAudio  = extOverride !== "auto" ? extOverride === "audio"  : AUDIO_EXTS.has(ext);
  const isPdf    = extOverride !== "auto" ? extOverride === "pdf"    : PDF_EXTS.has(ext);
  const isText   = extOverride !== "auto" ? extOverride === "text"   : (TEXT_EXTS.has(ext) || isSpecialText);
  const isNone   = extOverride === "none";
  // zip/tar.gz/tgz は解凍せず中身を一覧表示（ユーザーが型を上書きしていない場合のみ）
  const isArchive = extOverride === "auto" && isArchiveFile(ext, fileName);
  const isMarkdown = ext === "md" && isText;
  // shiki のハイライト対応判定（highlight セグメントを提供するかどうか）
  const shikiLang = shikiLangForExt(ext);

  const loadingRef = useRef(false);

  // Editor mode
  const [isEditing, setIsEditing] = useState(false);
  // 表示中ファイルの親ディレクトリで FS 変更が起きたら内容を再読込するためのカウンタ。
  const [reloadTick, setReloadTick] = useState(0);
  const [editContent, setEditContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Reset edit mode when file changes
  useEffect(() => {
    setIsEditing(false);
    setEditContent(null);
    setSaveMessage(null);
  }, [filePath]);

  // 編集で開ける上限。Rust 側 read_text_file の上限（MAX_PREVIEW_BYTES）と同じ。
  const EDIT_MAX_BYTES = 10 * 1024 * 1024;

  const openEditor = useCallback(async () => {
    if (!filePath) return;
    setSaveMessage(null);
    // プレビューの本文は maxBytes: 65536 で「途中で打ち切って」読んだもの。
    // それを editContent の初期値にすると、保存時に 64KB 以降が丸ごと
    // 消えてしまう（write_text_file は渡された文字列でファイルを置き換えるため）。
    // 編集に入るときは必ず全文を読み直し、上限を超えるものは編集させない。
    try {
      const meta = await invoke<{ size: number }>("get_file_metadata", { path: filePath });
      if (meta.size > EDIT_MAX_BYTES) {
        setSaveMessage({ ok: false, text: t("preview.tooLargeToEdit") });
        return;
      }
      const full = await invoke<string>("read_text_file", { path: filePath, maxBytes: EDIT_MAX_BYTES });
      setEditContent(full);
      setIsEditing(true);
    } catch (e) {
      console.error("[openEditor]", e);
      setSaveMessage({ ok: false, text: t("preview.failedLoadFile") });
    }
  }, [filePath, t]);

  const saveFile = useCallback(async () => {
    if (!filePath || editContent === null) return;
    setSaving(true);
    try {
      await invoke("write_text_file", { path: filePath, content: editContent });
      // 保存した内容をプレビュー側にも反映する。
      //
      // これが無いと「保存したのにプレビューが古いまま」になる。再読込の唯一の
      // きっかけが FS ウォッチャー（FS_DIR_CHANGED）で、しかも編集中は編集内容を
      // 壊さないよう意図的に無視しているため、保存 → 編集モードを閉じる、の順だと
      // 誰も content を更新しないまま古い本文が表示される。ウォッチャーは
      // 「一覧が見ているディレクトリ」しか監視しないので、そもそもイベントが
      // 来ないケースもある。書いた内容は手元にあるのだから、ここで確定させる。
      setContent(editContent);
      setSaveMessage({ ok: true, text: t("preview.saved") });
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (e) {
      setSaveMessage({ ok: false, text: t("preview.saveFailed", { error: String(e) }) });
    } finally {
      setSaving(false);
    }
  }, [filePath, editContent, t]);

  // Text preview: limit to first 50 lines by default
  const PREVIEW_LINES = 50;
  const [showFullText, setShowFullText] = useState(false);

  // Reset full-text toggle when file changes
  useEffect(() => {
    setShowFullText(false);
  }, [filePath]);

  // Hex viewer
  const [showHex, setShowHex] = useState(false);
  const [hexBytes, setHexBytes] = useState<number[]>([]);
  const [hexOffset, setHexOffset] = useState(0);
  const [hexFileSize, setHexFileSize] = useState(0);
  const HEX_PAGE = 512; // bytes per page

  const loadHexPage = useCallback(async (path: string, offset: number) => {
    try {
      const bytes = await invoke<number[]>("read_file_bytes", { path, offset, length: HEX_PAGE });
      setHexBytes(bytes);
      setHexOffset(offset);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!showHex || !filePath) return;
    setHexOffset(0);
    invoke<{ size: number }>("get_file_metadata", { path: filePath })
      .then((m) => setHexFileSize(m.size))
      .catch(() => setHexFileSize(0));
    loadHexPage(filePath, 0);
  }, [showHex, filePath, loadHexPage]);

  // Blame
  const [showBlame, setShowBlame] = useState(false);
  const [blameEntries, setBlameEntries] = useState<BlameEntry[]>([]);
  const [blameLoading, setBlameLoading] = useState(false);

  const loadBlame = useCallback(async (path: string) => {
    // Pass parent directory as repoPath so git2::Repository::discover() receives a directory
    const repoPath = path.replace(/[\\/][^\\/]+$/, "") || path;
    setBlameLoading(true);
    try {
      const entries = await invoke<BlameEntry[]>("git_blame", { repoPath, path });
      setBlameEntries(entries);
    } catch {
      setBlameEntries([]);
    } finally {
      setBlameLoading(false);
    }
  }, []);

  useEffect(() => {
    if (showBlame && filePath && isText) {
      loadBlame(filePath);
    } else {
      setBlameEntries([]);
    }
  }, [showBlame, filePath, isText, loadBlame]);

  // ファイル一覧の FS ウォッチャー（fs:changed → FS_DIR_CHANGED）を購読し、
  // 表示中ファイルの親ディレクトリに変更があれば内容を自動再読込する。
  // 編集モード中は上書きしない（編集内容が失われるため）。
  const isEditingRef = useRef(isEditing);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);
  useEffect(() => {
    if (!filePath) return;
    const dir = filePath.replace(/[\\/][^\\/]*$/, "");
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path: string };
      if (detail?.path === dir && !isEditingRef.current) {
        setReloadTick((n) => n + 1);
      }
    };
    window.addEventListener(APP_EVENTS.FS_DIR_CHANGED, handler);
    return () => window.removeEventListener(APP_EVENTS.FS_DIR_CHANGED, handler);
  }, [filePath]);

  // Reset render mode when file changes
  useEffect(() => {
    if (isMarkdown) setRenderMode("markdown");
    else if (shikiLang) setRenderMode("highlight");
    else setRenderMode("plain");
  }, [filePath]);

  useEffect(() => {
    if (!filePath) {
      setContent(null);
      setImgSrc(null);
      setMediaSrc(null);
      setArchiveEntries(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setContent(null);
    setImgSrc(null);
    setMediaSrc(null);
    setArchiveEntries(null);
    setError(null);
    setExifData(null);
    setShowExif(false);

    if (isImage) {
      setLoading(true);
      invoke<string>("read_file_as_data_url", { path: filePath, mimeType: IMAGE_MIME[ext] ?? "image/jpeg" })
        .then((src) => { if (!cancelled) setImgSrc(src); })
        .catch(() => { if (!cancelled) setError(t("preview.failedLoadImage")); })
        .finally(() => { if (!cancelled) setLoading(false); });
      // Fetch EXIF in the background for formats that may carry it.
      // Missing EXIF / parse errors are silently ignored (no metadata is normal).
      if (EXIF_EXTS.has(ext)) {
        invoke<ExifData>("get_exif_data", { path: filePath })
          .then((d) => { if (!cancelled && hasAnyExif(d)) setExifData(d); })
          .catch(() => { /* no EXIF — silent */ });
      }
      return;
    }

    if (isVideo || isAudio || isPdf) {
      setMediaSrc(convertFileSrc(filePath));
      return;
    }

    if (isArchive) {
      setLoading(true);
      invoke<ArchiveEntry[]>("list_archive", { path: filePath })
        .then((es) => { if (!cancelled) setArchiveEntries(es); })
        .catch((e) => { if (!cancelled) { console.error("[list_archive]", e); setError(t("preview.failedLoadArchive", "アーカイブの読み込みに失敗しました")); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }

    if (isText) {
      setLoading(true);
      loadingRef.current = true;
      invoke<string>("read_text_file", { path: filePath, maxBytes: 65536 })
        .then((text) => { if (!cancelled) setContent(typeof text === "string" ? text : String(text ?? "")); })
        .catch((e) => { if (!cancelled) { console.error("[read_text_file]", e); setError(t("preview.failedLoadFile")); } })
        .finally(() => { if (!cancelled) { setLoading(false); loadingRef.current = false; } });
    } else if (!isImage && !isVideo && !isAudio && !isPdf && !isArchive && !isNone) {
      // 既知のどの型にも該当しない（かつユーザーが "none" 指定していない）場合、
      // 内容を読んでテキストと判定できたら表示する。プレビューできない形式を
      // できるだけ減らすための内容ベース判定。バイナリなら非対応表示のまま。
      setLoading(true);
      loadingRef.current = true;
      invoke<{ isText: boolean; content: string }>("read_text_file_sniffed", { path: filePath, maxBytes: 65536 })
        .then((r) => { if (!cancelled && r.isText) setContent(r.content); })
        .catch(() => { /* 読めなければ非対応表示のまま */ })
        .finally(() => { if (!cancelled) { setLoading(false); loadingRef.current = false; } });
    }

    return () => { cancelled = true; };
  }, [filePath, reloadTick]);

  // Derive display content: first 50 lines unless showFullText
  const totalLines = content ? content.split("\n").length : 0;
  const isTruncated = !showFullText && totalLines > PREVIEW_LINES;
  const displayContent = content && isTruncated
    ? content.split("\n").slice(0, PREVIEW_LINES).join("\n")
    : content;

  // shiki によるハイライト結果を非同期に計算する。
  // undefined = 計算中/未着手（対応拡張子でしばらく空表示になるのは許容）、
  // null = ハイライト対象外または失敗（プレーン表示にフォールバック）、
  // string = 完成した shiki の HTML。
  const [highlightedHtml, setHighlightedHtml] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!displayContent || renderMode !== "highlight" || !shikiLang) {
      setHighlightedHtml(null);
      return;
    }
    let cancelled = false;
    setHighlightedHtml(undefined);
    highlightWithShiki(displayContent, ext, {
      theme: codePreviewTheme,
      appIsDark,
      overrides: codeHighlightColors,
      customTheme: customCodeTheme,
    }).then((html) => {
      if (!cancelled) setHighlightedHtml(html);
    });
    return () => { cancelled = true; };
  }, [displayContent, renderMode, shikiLang, ext, codePreviewTheme, codeHighlightColors, customCodeTheme, appIsDark]);

  const markdownHtml = useMemo(() => {
    if (!displayContent || renderMode !== "markdown") return null;
    try {
      return DOMPurify.sanitize(marked.parse(displayContent) as string);
    } catch {
      return null;
    }
  }, [displayContent, renderMode]);

  // 表示スタイルはヘッダのセグメント切替で明示的に選択する（旧: 循環トグル）。
  const modeTitle = t("quickPreview.toggleViewMode");

  return (
    <div
      className={
        fill
          ? "flex flex-col text-xs overflow-hidden relative w-full h-full"
          : "flex-shrink-0 flex flex-col border-l text-xs overflow-hidden relative"
      }
      style={{
        // ペイン表示時はコンテナいっぱい。サイドパネル時のみ固定幅。
        ...(fill ? {} : { width }),
        backgroundColor: "var(--kf-bg-primary)",
        borderColor: "var(--kf-border)",
        color: "var(--kf-text-primary)",
      }}
    >
      {/* リサイズハンドル（サイドパネル時のみ。ペイン時はペイン間セパレータでリサイズ） */}
      {!fill && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-blue-500 hover:opacity-60"
          style={{ touchAction: "none" }}
          onMouseDown={handleDragStart}
        />
      )}
      {/* ヘッダー */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{
          backgroundColor: "var(--kf-bg-secondary)",
          borderColor: "var(--kf-border)",
          color: "var(--kf-text-muted)",
        }}
      >
        <Icon name="preview" size={14} />
        <span className="font-semibold truncate flex-1" style={{ color: "var(--kf-text-primary)" }}>
          {fileName || t("preview.title")}
        </span>
        {filePath && !isVideo && !isAudio && !isPdf && (
          <button
            onClick={() => { setShowHex((v) => !v); setShowBlame(false); }}
            className={`flex items-center ${showHex ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
            title={t("previewPanel.hexViewer")}
            style={showHex ? { color: "var(--kf-accent)" } : undefined}
          >
            <Icon name="data_object" size={14} />
          </button>
        )}
        {isImage && exifData && (
          <button
            onClick={() => setShowExif((v) => !v)}
            className={`flex items-center ${showExif ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
            title={t("preview.exifInfo")}
            style={showExif ? { color: "var(--kf-accent)" } : undefined}
          >
            <Icon name="info" size={14} />
          </button>
        )}
        {content !== null && isText && !showHex && (
          <>
            <button
              onClick={() => {
                if (isEditing) {
                  setIsEditing(false);
                } else {
                  openEditor();
                }
              }}
              className={`flex items-center ${isEditing ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
              title={isEditing ? t("preview.backToPreview") : t("preview.edit")}
              style={isEditing ? { color: "var(--kf-accent)" } : undefined}
            >
              <Icon name="edit" size={14} />
            </button>
            {isEditing && (
              <button
                onClick={saveFile}
                disabled={saving}
                className={`flex items-center ${saving ? "opacity-40" : "opacity-70 hover:opacity-100"}`}
                title={t("previewPanel.save", { key: formatModCombo("S") })}
              >
                <Icon name="save" size={14} />
              </button>
            )}
          </>
        )}
        {content !== null && isText && !showHex && !isEditing && (
          <button
            onClick={() => setShowBlame((v) => !v)}
            className={`flex items-center ${showBlame ? "opacity-100" : "opacity-50 hover:opacity-100"}`}
            title="git blame"
            style={showBlame ? { color: "var(--kf-accent)" } : undefined}
          >
            <Icon name="person_search" size={14} />
          </button>
        )}
        {content !== null && (shikiLang || isMarkdown) && !showBlame && !isEditing && (
          /* 表示スタイルの明示的な選択（QuickPreviewModal と同じセグメント切替） */
          <div
            className="flex items-center rounded overflow-hidden shrink-0"
            style={{ border: "1px solid var(--kf-border)" }}
            role="group"
            aria-label={modeTitle}
          >
            {([
              ...(shikiLang ? [{ mode: "highlight" as const, icon: "code", label: t("quickPreview.styleHighlight") }] : []),
              ...(isMarkdown ? [{ mode: "markdown" as const, icon: "article", label: t("quickPreview.styleMarkdown") }] : []),
              { mode: "plain" as const, icon: "text_snippet", label: t("quickPreview.stylePlain") },
            ]).map(({ mode, icon, label }) => (
              <button
                key={mode}
                onClick={() => setRenderMode(mode)}
                title={label}
                aria-pressed={renderMode === mode}
                className="flex items-center px-1 py-0.5"
                style={{
                  color: renderMode === mode ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-muted)",
                  backgroundColor: renderMode === mode ? "var(--kf-accent)" : "transparent",
                }}
              >
                <Icon name={icon} size={12} />
              </button>
            ))}
          </div>
        )}
        <button
          onClick={onClose}
          className="flex items-center opacity-40 hover:opacity-100 transition-opacity ml-1"
          title={t("common.close")}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* コンテンツ */}
      <div className="flex-1 overflow-auto" style={{ position: "relative" }}>
        {/* Monaco エディタ */}
        {isEditing && isText && filePath && (
          <div
            className="flex flex-col"
            style={{ height: "100%", position: "absolute", inset: 0 }}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveFile(); } }}
          >
            {saveMessage && (
              <div
                className="px-3 py-1 text-[10px] shrink-0"
                style={{
                  backgroundColor: saveMessage.ok ? "var(--kf-success-bg)" : "var(--kf-error-bg)",
                  color: "#fff",
                }}
              >
                {saveMessage.text}
              </div>
            )}
            <div style={{ flex: 1 }}>
              <Suspense
                fallback={
                  <div
                    className="flex items-center justify-center h-full gap-2"
                    style={{ color: "var(--kf-text-muted)" }}
                  >
                    <Icon name="progress_activity" size={18} className="animate-spin" />
                    {t("previewPanel.loadingEditor", "エディタを読み込み中...")}
                  </div>
                }
              >
                <CodeEditor
                  language={EXT_TO_LANG[ext] ?? "plaintext"}
                  value={editContent ?? ""}
                  onChange={setEditContent}
                />
              </Suspense>
            </div>
          </div>
        )}

        {!filePath && (
          <div
            className="flex flex-col items-center justify-center h-full gap-2"
            style={{ color: "var(--kf-text-muted)" }}
          >
            <Icon name="preview" size={32} />
            <span>{t("previewPanel.selectFile")}</span>
          </div>
        )}

        {!isEditing && loading && (
          <div
            className="flex items-center justify-center h-full gap-2"
            style={{ color: "var(--kf-text-muted)" }}
          >
            <Icon name="progress_activity" size={18} className="animate-spin" />
            {t("common.loading")}
          </div>
        )}

        {!isEditing && error && (
          <div className="p-3 text-red-400 flex items-center gap-1">
            <Icon name="error" size={14} />
            {error}
          </div>
        )}

        {imgSrc && (
          <img
            src={imgSrc}
            alt={fileName}
            className="max-w-full h-auto p-2"
            onError={() => setError(t("preview.failedLoadImage"))}
          />
        )}

        {imgSrc && showExif && exifData && <ExifTable data={exifData} />}

        {mediaSrc && isVideo && (
          <video
            src={mediaSrc}
            controls
            className="w-full h-auto max-h-full p-2"
            style={{ display: "block" }}
            onError={() => setError(t("preview.failedPlayVideo"))}
          />
        )}

        {mediaSrc && isAudio && (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
            <Icon name="audio_file" size={48} style={{ color: "var(--kf-text-muted)" }} />
            <span className="text-xs truncate max-w-full" style={{ color: "var(--kf-text-secondary)" }}>{fileName}</span>
            <audio
              src={mediaSrc}
              controls
              style={{ width: "100%" }}
              onError={() => setError(t("preview.failedPlayAudio"))}
            />
          </div>
        )}

        {mediaSrc && isPdf && (
          <object
            data={mediaSrc}
            type="application/pdf"
            style={{ width: "100%", height: "100%", border: "none" }}
          >
            <div
              className="flex flex-col items-center justify-center h-full gap-2"
              style={{ color: "var(--kf-text-muted)" }}
            >
              <Icon name="picture_as_pdf" size={32} />
              <span>{t("previewPanel.pdfNotSupported")}</span>
            </div>
          </object>
        )}

        {/* Git blame view */}
        {!isEditing && showBlame && !showHex && displayContent !== null && (
          <div className="flex-1 overflow-auto">
            {blameLoading && (
              <div className="flex items-center justify-center py-4 gap-1" style={{ color: "var(--kf-text-muted)" }}>
                <Icon name="progress_activity" size={14} className="animate-spin" />
                {t("previewPanel.blameLoading")}
              </div>
            )}
            {!blameLoading && blameEntries.length === 0 && (
              <div className="p-3 text-xs" style={{ color: "var(--kf-text-muted)" }}>
                {t("previewPanel.blameNone")}
              </div>
            )}
            {!blameLoading && blameEntries.length > 0 && displayContent.split("\n").map((line, idx) => {
              const b = blameEntries[idx];
              return (
                <div
                  key={idx}
                  className="flex items-start gap-0 text-[10px] leading-relaxed border-b"
                  style={{ borderColor: "rgba(255,255,255,0.04)", fontFamily: "monospace" }}
                >
                  <span
                    className="shrink-0 px-1 select-none text-right"
                    style={{ width: 28, color: "var(--kf-text-muted)", backgroundColor: "var(--kf-bg-secondary)" }}
                  >
                    {idx + 1}
                  </span>
                  {b ? (
                    <span
                      className="shrink-0 px-1 truncate select-none"
                      style={{ width: 72, color: "var(--kf-accent)", backgroundColor: "var(--kf-bg-secondary)" }}
                      title={`${b.oid} ${b.author}: ${b.message}`}
                    >
                      {b.oid}
                    </span>
                  ) : (
                    <span className="shrink-0 px-1" style={{ width: 72, backgroundColor: "var(--kf-bg-secondary)" }} />
                  )}
                  <span className="flex-1 px-2 whitespace-pre" style={{ color: "var(--kf-text-primary)" }}>
                    {line}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Markdown rendered */}
        {!isEditing && !showBlame && !showHex && markdownHtml !== null && (
          <div
            className={`kf-markdown ${markdownPreviewTheme === "dark" ? "kf-md-dark" : ""} p-3 max-w-none`}
            style={{ color: "var(--kf-text-primary)", fontSize: "11px", lineHeight: "1.6" }}
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        )}

        {/* Syntax highlighted (shiki) */}
        {!isEditing && !showBlame && !showHex && content !== null && typeof highlightedHtml === "string" && (
          <div className="kf-shiki text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        )}

        {/* Plain text（shiki が使えない拡張子・失敗時のフォールバックを含む） */}
        {!isEditing && !showBlame && !showHex && displayContent !== null &&
          (renderMode === "plain" || (renderMode === "highlight" && highlightedHtml === null)) && (
          <pre
            className={`kf-code-view ${codePreviewTheme === "app" ? "kf-code-follow" : ""} p-3 text-xs leading-relaxed whitespace-pre-wrap break-all`}
            style={{ fontFamily: "monospace", minHeight: "100%", ...hlStyle }}
          >
            {displayContent}
          </pre>
        )}

        {/* Truncation banner */}
        {!isEditing && !showBlame && !showHex && isTruncated && (
          <div
            className="flex items-center justify-between gap-2 px-3 py-1.5 shrink-0 border-t text-[10px]"
            style={{
              backgroundColor: "var(--kf-bg-secondary)",
              borderColor: "var(--kf-border)",
              color: "var(--kf-text-muted)",
            }}
          >
            <span>{t("previewPanel.headLines", { head: PREVIEW_LINES, total: totalLines })}</span>
            <button
              onClick={() => setShowFullText(true)}
              className="px-2 py-0.5 rounded hover:opacity-80"
              style={{ backgroundColor: "var(--kf-bg-tertiary)", border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
            >
              {t("previewPanel.loadFullText")}
            </button>
          </div>
        )}
        {!isEditing && !showBlame && !showHex && showFullText && totalLines > PREVIEW_LINES && (
          <div
            className="flex items-center justify-between gap-2 px-3 py-1.5 shrink-0 border-t text-[10px]"
            style={{
              backgroundColor: "var(--kf-bg-secondary)",
              borderColor: "var(--kf-border)",
              color: "var(--kf-text-muted)",
            }}
          >
            <span>{t("previewPanel.totalLines", { count: totalLines })}</span>
            <button
              onClick={() => setShowFullText(false)}
              className="px-2 py-0.5 rounded hover:opacity-80"
              style={{ backgroundColor: "var(--kf-bg-tertiary)", border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
            >
              {t("previewPanel.backToHead", { count: PREVIEW_LINES })}
            </button>
          </div>
        )}

        {/* Hex viewer */}
        {!isEditing && showHex && filePath && hexBytes.length > 0 && (
          <div className="flex flex-col h-full">
            <div
              className="font-mono text-[10px] leading-relaxed overflow-auto flex-1"
              style={{ backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-secondary)" }}
            >
              {Array.from({ length: Math.ceil(hexBytes.length / 16) }, (_, row) => {
                const start = row * 16;
                const rowBytes = hexBytes.slice(start, start + 16);
                const addrHex = (hexOffset + start).toString(16).padStart(8, "0");
                const hexParts = rowBytes.map((b) => b.toString(16).padStart(2, "0"));
                while (hexParts.length < 16) hexParts.push("  ");
                const ascii = rowBytes.map((b) =>
                  b >= 32 && b < 127 ? String.fromCharCode(b) : "."
                ).join("");
                return (
                  <div key={row} className="flex gap-2 px-2 py-0.5 hover:opacity-80" style={{ fontFamily: "monospace" }}>
                    <span style={{ color: "var(--kf-text-muted)", minWidth: 68 }}>{addrHex}</span>
                    <span style={{ color: "#60a5fa", minWidth: 140 }}>
                      {hexParts.slice(0, 8).join(" ")}
                    </span>
                    <span style={{ color: "#60a5fa", minWidth: 140 }}>
                      {hexParts.slice(8, 16).join(" ")}
                    </span>
                    <span style={{ color: "var(--kf-text-muted)", borderLeft: "1px solid var(--kf-border)", paddingLeft: 8 }}>
                      {ascii}
                    </span>
                  </div>
                );
              })}
            </div>
            {/* Hex pagination */}
            <div
              className="flex items-center gap-2 px-3 py-1 shrink-0 border-t text-[10px]"
              style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)", color: "var(--kf-text-muted)" }}
            >
              <button
                onClick={() => loadHexPage(filePath, Math.max(0, hexOffset - HEX_PAGE))}
                disabled={hexOffset === 0}
                className="flex items-center disabled:opacity-30 hover:opacity-80"
              >
                <Icon name="chevron_left" size={13} />
              </button>
              <span>0x{hexOffset.toString(16).padStart(8, "0")}</span>
              <button
                onClick={() => loadHexPage(filePath, hexOffset + HEX_PAGE)}
                disabled={hexOffset + HEX_PAGE >= hexFileSize}
                className="flex items-center disabled:opacity-30 hover:opacity-80"
              >
                <Icon name="chevron_right" size={13} />
              </button>
              <span className="ml-auto">{hexFileSize > 0 ? t("previewPanel.hexBytes", { offset: hexOffset, size: hexFileSize }) : ""}</span>
            </div>
          </div>
        )}

        {/* アーカイブ（zip / tar.gz / tgz）の中身を解凍せず一覧表示 */}
        {filePath && isArchive && archiveEntries && !loading && !error && (
          <div className="flex flex-col">
            <div
              className="flex items-center gap-1.5 px-2 py-1 shrink-0 border-b text-[10px]"
              style={{ borderColor: "var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)", color: "var(--kf-text-muted)" }}
            >
              <Icon name="folder_zip" size={12} style={{ color: "var(--kf-accent)" }} />
              <span>{t("previewPanel.archiveEntryCount", "{{count}} エントリ", { count: archiveEntries.length })}</span>
            </div>
            {archiveEntries.map((e) => {
              const depth = Math.max(0, e.path.replace(/\/+$/, "").split("/").length - 1);
              return (
                <div
                  key={e.path}
                  className="flex items-center gap-1.5 px-2 py-0.5 border-b text-[11px]"
                  style={{ borderColor: "var(--kf-border-soft)" }}
                  title={e.path}
                >
                  <span style={{ width: depth * 12, flexShrink: 0 }} />
                  <Icon
                    name={e.isDir ? "folder" : "description"}
                    size={13}
                    style={{ color: e.isDir ? "var(--kf-accent)" : "var(--kf-text-muted)", flexShrink: 0 }}
                  />
                  <span className="flex-1 truncate" style={{ color: "var(--kf-text-primary)" }}>{e.name}</span>
                  {!e.isDir && (
                    <span style={{ color: "var(--kf-text-muted)" }}>{formatArchiveSize(e.size)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {filePath && !isArchive && content === null && (isNone || (!isImage && !isVideo && !isAudio && !isPdf && !isText)) && !showHex && !loading && !error && (
          <div
            className="flex flex-col items-center justify-center h-full gap-2"
            style={{ color: "var(--kf-text-muted)" }}
          >
            <Icon name="description" size={32} />
            <span>{t("previewPanel.notSupported")}</span>
            <span style={{ fontSize: "10px" }}>{ext ? `.${ext}` : fileName}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ExifTable は ./ExifTable に移動（複数のプレビューUIで共有）。
