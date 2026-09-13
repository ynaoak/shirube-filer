import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useUiSettings } from "../../store/uiSettingsStore";
import { hlColorsToStyle } from "../../lib/highlightTheme";
import { highlightWithShiki, shikiLangForExt } from "../../lib/shikiHighlighter";
import { useAppIsDark } from "../../hooks/useAppIsDark";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useModal } from "../../hooks/useModal";
import Icon from "../common/Icon";
import { ExifData, EXIF_EXTS, hasAnyExif, ExifTable } from "../viewers/ExifTable";

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
// 拡張子を持たない既知のテキストファイル名（小文字比較）。
const BARE_TEXT_NAMES = new Set(["dockerfile", ".gitignore", ".dockerignore", ".env", "makefile", "rakefile", "procfile"]);

/**
 * ダブルクリックでテキストビューア（このモーダル）を開く対象かどうか。
 * ユーザーが「プレビュー対応に登録」した拡張子（previewExtConfig の "text"）も含める。
 */
export function isTextViewable(
  fileName: string,
  extension: string | null,
  previewExtConfig?: Record<string, string>,
): boolean {
  const ext = (extension ?? "").toLowerCase();
  return (
    TEXT_EXTS.has(ext) ||
    BARE_TEXT_NAMES.has(fileName.toLowerCase()) ||
    previewExtConfig?.[ext] === "text"
  );
}

type Props = {
  path: string;
  siblings: string[]; // 同ディレクトリの全ファイルパス（左右ナビゲーション用）
  onClose: () => void;
  /** 独立ウィンドウ（mode=md-viewer）として全面表示する。onClose はウィンドウを閉じる */
  standalone?: boolean;
};

export default function QuickPreviewModal({ path: initialPath, siblings, onClose, standalone = false }: Props) {
  const { t } = useTranslation();
  const [{ codePreviewTheme, markdownPreviewTheme, codeHighlightColors, customCodeTheme }] = useUiSettings();
  const hlStyle = hlColorsToStyle(codeHighlightColors);
  const appIsDark = useAppIsDark();
  const dialogRef = useModal<HTMLDivElement>({ onClose, closeOnEsc: false, autoFocus: false });
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [content, setContent] = useState<string | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exifData, setExifData] = useState<ExifData | null>(null);
  const [showExif, setShowExif] = useState(false);

  const fileName = currentPath.split(/[\\/]/).pop() ?? "";
  const extRaw = currentPath.split(".").pop()?.toLowerCase() ?? "";
  const ext = extRaw === fileName.toLowerCase() ? "" : extRaw;
  const isImage = IMAGE_EXTS.has(ext);
  const isVideo = VIDEO_EXTS.has(ext);
  const isAudio = AUDIO_EXTS.has(ext);
  const isPdf = PDF_EXTS.has(ext);
  const isMarkdown = ext === "md";
  const shikiLang = shikiLangForExt(ext);

  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"highlight" | "markdown" | "plain">(() =>
    isMarkdown ? "markdown" : shikiLang ? "highlight" : "plain"
  );

  // Reset render mode when file changes
  useEffect(() => {
    setRenderMode(isMarkdown ? "markdown" : shikiLang ? "highlight" : "plain");
  }, [currentPath]);

  // Load file
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setImgSrc(null);
    setMediaSrc(null);
    setError(null);
    setExifData(null);
    setShowExif(false);

    if (isImage) {
      setLoading(true);
      invoke<string>("read_file_as_data_url", { path: currentPath, mimeType: IMAGE_MIME[ext] ?? "image/jpeg" })
        .then(src => { if (!cancelled) setImgSrc(src); })
        .catch(() => { if (!cancelled) setError(t("quickPreview.failedLoadImage")); })
        .finally(() => { if (!cancelled) setLoading(false); });
      // EXIF をバックグラウンド取得（持たない形式・解析失敗は無視）。
      if (EXIF_EXTS.has(ext)) {
        invoke<ExifData>("get_exif_data", { path: currentPath })
          .then((d) => { if (!cancelled && hasAnyExif(d)) setExifData(d); })
          .catch(() => { /* EXIF なし — 無視 */ });
      }
      return;
    }
    if (isVideo || isAudio || isPdf) {
      setMediaSrc(convertFileSrc(currentPath));
      return;
    }
    // 画像・動画・音声・PDF 以外は、内容を読んでテキスト表示可能か判定する。
    // 拡張子が未知でも「テキストと判定できたもの」は表示する（プレビュー
    // できない形式をできるだけ減らす）。バイナリと判定されたら content は
    // null のままとなり、非対応表示にフォールバックする。
    setLoading(true);
    invoke<{ isText: boolean; content: string }>("read_text_file_sniffed", { path: currentPath, maxBytes: 65536 })
      .then((r) => { if (!cancelled) setContent(r.isText ? r.content : null); })
      .catch(() => { if (!cancelled) setError(t("quickPreview.failedLoadFile")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentPath]);

  // undefined = 計算中/未着手、null = 対象外・失敗（プレーンにフォールバック）、string = HTML
  const [highlightedHtml, setHighlightedHtml] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!content || renderMode !== "highlight" || !shikiLang) {
      setHighlightedHtml(null);
      return;
    }
    let cancelled = false;
    setHighlightedHtml(undefined);
    highlightWithShiki(content, ext, {
      theme: codePreviewTheme,
      appIsDark,
      overrides: codeHighlightColors,
      customTheme: customCodeTheme,
    }).then((html) => {
      if (!cancelled) setHighlightedHtml(html);
    });
    return () => { cancelled = true; };
  }, [content, renderMode, shikiLang, ext, codePreviewTheme, codeHighlightColors, customCodeTheme, appIsDark]);

  const markdownHtml = useMemo(() => {
    if (!content || renderMode !== "markdown") return null;
    try { return DOMPurify.sanitize(marked.parse(content) as string); } catch { return null; }
  }, [content, renderMode]);

  // Navigate between siblings
  const currentIdx = siblings.indexOf(currentPath);
  const goPrev = () => { if (currentIdx > 0) setCurrentPath(siblings[currentIdx - 1]); };
  const goNext = () => { if (currentIdx < siblings.length - 1) setCurrentPath(siblings[currentIdx + 1]); };

  // Keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 独立ウィンドウでは Space での即閉じは行わない（スクロールと衝突するため）
      if (e.key === "Escape" || (!standalone && e.key === " ")) { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentIdx, siblings, onClose]);

  return (
    <div
      className={standalone
        ? "flex items-stretch justify-center w-screen h-screen"
        : "kf-anim-fade fixed inset-0 z-50 flex items-center justify-center"}
      style={{ backgroundColor: standalone ? "var(--kf-bg-primary)" : "rgba(0,0,0,0.6)" }}
      onClick={standalone ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("quickPreview.title", "クイックプレビュー")}
        className={standalone
          ? "flex flex-col overflow-hidden w-full h-full"
          : "kf-anim-scale flex flex-col rounded-xl shadow-2xl overflow-hidden"}
        style={standalone ? { backgroundColor: "var(--kf-bg-primary)" } : {
          backgroundColor: "var(--kf-bg-primary)",
          border: "1px solid var(--kf-border)",
          width: "min(90vw, 900px)",
          height: "min(85vh, 700px)",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div
          className="flex items-center gap-2 px-4 py-2 shrink-0"
          style={{ borderBottom: "1px solid var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)" }}
        >
          <button aria-label={t("common.previous", "前へ")} onClick={goPrev} disabled={currentIdx <= 0}
            style={{ opacity: currentIdx <= 0 ? 0.3 : 1, cursor: currentIdx <= 0 ? "default" : "pointer" }}>
            <Icon name="chevron_left" size={18} />
          </button>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: "var(--kf-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fileName}
          </span>
          {content !== null && (shikiLang || isMarkdown) && (
            /* 表示スタイルの明示的な選択（循環トグルは現在状態が分かりにくいため廃止） */
            <div
              className="flex items-center rounded overflow-hidden"
              style={{ border: "1px solid var(--kf-border)" }}
              role="group"
              aria-label={t("quickPreview.toggleViewMode")}
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
                  className="flex items-center px-1.5 py-0.5"
                  style={{
                    color: renderMode === mode ? "var(--kf-accent-fg, #fff)" : "var(--kf-text-muted)",
                    backgroundColor: renderMode === mode ? "var(--kf-accent)" : "transparent",
                  }}
                >
                  <Icon name={icon} size={14} />
                </button>
              ))}
            </div>
          )}
          {exifData && (
            <button
              onClick={() => setShowExif((v) => !v)}
              title={t("preview.exifInfo")}
              style={{ color: showExif ? "var(--kf-accent)" : "var(--kf-text-muted)" }}
            >
              <Icon name="info" size={16} />
            </button>
          )}
          <button onClick={goNext} disabled={currentIdx >= siblings.length - 1}
            style={{ opacity: currentIdx >= siblings.length - 1 ? 0.3 : 1, cursor: currentIdx >= siblings.length - 1 ? "default" : "pointer" }}>
            <Icon name="chevron_right" size={18} />
          </button>
          <button aria-label={t("common.close")} onClick={onClose} style={{ color: "var(--kf-text-muted)" }}>
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* コンテンツ */}
        <div className="flex-1 overflow-auto" style={{ position: "relative" }}>
          {loading && (
            <div className="flex items-center justify-center h-full" style={{ color: "var(--kf-text-muted)", fontSize: 13 }}>
              {t("common.loading")}
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full" style={{ color: "var(--kf-error)", fontSize: 13 }}>
              {error}
            </div>
          )}
          {imgSrc && (
            <div className="flex items-center justify-center h-full p-4">
              <img src={imgSrc} alt={fileName} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
            </div>
          )}
          {showExif && exifData && (
            <div
              className="absolute top-2 right-2 z-10 w-64 max-h-[88%] overflow-y-auto rounded-lg shadow-2xl py-2"
              style={{ backgroundColor: "var(--kf-bg-primary)", border: "1px solid var(--kf-border)" }}
            >
              <ExifTable data={exifData} />
            </div>
          )}
          {mediaSrc && isVideo && (
            <div className="flex items-center justify-center h-full p-4">
              <video
                src={mediaSrc}
                controls
                autoPlay
                style={{ maxWidth: "100%", maxHeight: "100%" }}
                onError={() => setError(t("quickPreview.failedPlayVideo"))}
              />
            </div>
          )}
          {mediaSrc && isAudio && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <Icon name="audio_file" size={64} style={{ color: "var(--kf-text-muted)" }} />
              <span style={{ fontSize: 13, color: "var(--kf-text-secondary)" }}>{fileName}</span>
              <audio
                src={mediaSrc}
                controls
                autoPlay
                style={{ width: "80%" }}
                onError={() => setError(t("quickPreview.failedPlayAudio"))}
              />
            </div>
          )}
          {mediaSrc && isPdf && (
            <object
              data={mediaSrc}
              type="application/pdf"
              style={{ width: "100%", height: "100%", border: "none" }}
            >
              <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: "var(--kf-text-muted)" }}>
                <Icon name="picture_as_pdf" size={48} />
                <span style={{ fontSize: 13 }}>{t("quickPreview.pdfNotSupported")}</span>
              </div>
            </object>
          )}
          {content !== null && renderMode === "highlight" && typeof highlightedHtml === "string" && (
            <div className="kf-shiki text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          )}
          {content !== null && renderMode === "markdown" && markdownHtml && (
            <div className={`kf-markdown ${markdownPreviewTheme === "dark" ? "kf-md-dark" : ""} max-w-none p-6`} style={{ color: "var(--kf-text-primary)" }}
              dangerouslySetInnerHTML={{ __html: markdownHtml }} />
          )}
          {content !== null && (renderMode === "plain" || (renderMode === "highlight" && highlightedHtml === null)) && (
            <pre className={`kf-code-view ${codePreviewTheme === "app" ? "kf-code-follow" : ""}`} style={{ margin: 0, padding: "16px", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all", minHeight: "100%", ...hlStyle }}>
              {content}
            </pre>
          )}
          {!loading && !error && !imgSrc && !mediaSrc && content === null && !isImage && !isVideo && !isAudio && !isPdf && (
            <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: "var(--kf-text-muted)" }}>
              <Icon name="description" size={48} />
              <span style={{ fontSize: 13 }}>{t("quickPreview.unsupportedFormat")}</span>
            </div>
          )}
        </div>

        {/* フッター */}
        <div
          className="px-4 py-1 shrink-0"
          style={{ borderTop: "1px solid var(--kf-border)", backgroundColor: "var(--kf-bg-secondary)", fontSize: 11, color: "var(--kf-text-muted)" }}
        >
          {t(standalone ? "quickPreview.hintWindow" : "quickPreview.hint")}
          {!standalone && currentIdx >= 0 && <span className="ml-4">{currentIdx + 1} / {siblings.length}</span>}
        </div>
      </div>
    </div>
  );
}
