import type { FileEntry } from "../../types/fs";

/** 種別アイコンの見た目（Material Symbols のリガチャ名と色）。 */
export type FileIconSpec = { name: string; color: string };

/**
 * ファイル種別 → アイコン名と色。
 *
 * FileIcon（React）とドラッグ中のカーソル追従画像（素の DOM で組み立てる）の
 * 両方から使うため、JSX を含まない純粋な関数として切り出している。
 * ここを直せば一覧とドラッグ画像の見た目が同時に揃う。
 */
export function fileIconSpec(entry: FileEntry): FileIconSpec {
  if (entry.isDir) return { name: "folder", color: "var(--kf-accent)" };
  if (entry.isSymlink) return { name: "link", color: "var(--kf-text-muted)" };

  switch (entry.extension?.toLowerCase()) {
    case "jpg": case "jpeg": case "png": case "gif": case "svg": case "webp":
      return { name: "image", color: "var(--kf-ft-image)" };
    case "mp4": case "mov": case "avi": case "mkv":
      return { name: "movie", color: "var(--kf-ft-video)" };
    case "mp3": case "wav": case "flac":
      return { name: "music_note", color: "var(--kf-ft-audio)" };
    case "zip": case "tar": case "gz": case "7z": case "rar":
      return { name: "folder_zip", color: "var(--kf-ft-archive)" };
    case "pdf":
      return { name: "picture_as_pdf", color: "var(--kf-ft-video)" };
    case "rs": case "ts": case "tsx": case "js": case "jsx": case "py": case "go":
      return { name: "code", color: "var(--kf-ft-code)" };
    case "doc": case "docx":
      return { name: "description", color: "var(--kf-ft-code)" };
    case "xls": case "xlsx": case "csv":
      return { name: "table", color: "var(--kf-ft-audio)" };
    case "ppt": case "pptx":
      return { name: "slideshow", color: "var(--kf-ft-archive)" };
    case "md": case "txt":
      return { name: "article", color: "var(--kf-text-secondary)" };
    default:
      return { name: "description", color: "var(--kf-text-muted)" };
  }
}

/**
 * 立体アイコン（DimensionalIcon）用の種別。
 *
 * Material のリガチャ名は「絵柄」を指すのに対し、こちらは「ファイルの種類」を
 * 指す。同じ絵柄を別種別に使い回している箇所（pdf と動画がどちらも
 * picture_as_pdf 系の色を共有する等）があるため、立体アイコン側は種類で
 * 分けられるよう独立させている。
 */
export type FileIconKind =
  | "folder" | "link"
  | "image" | "video" | "audio" | "archive" | "pdf"
  | "code" | "word" | "excel" | "ppt" | "text"
  | "generic";

/** ファイル種別 → 立体アイコンの種類。 */
export function fileIconKind(entry: FileEntry): FileIconKind {
  if (entry.isDir) return "folder";
  if (entry.isSymlink) return "link";

  switch (entry.extension?.toLowerCase()) {
    case "jpg": case "jpeg": case "png": case "gif": case "svg": case "webp":
    case "bmp": case "ico": case "avif": case "heic": case "tiff":
      return "image";
    case "mp4": case "mov": case "avi": case "mkv": case "webm": case "m4v":
      return "video";
    case "mp3": case "wav": case "flac": case "aac": case "m4a": case "ogg": case "opus":
      return "audio";
    case "zip": case "tar": case "gz": case "7z": case "rar": case "bz2": case "xz": case "zst":
      return "archive";
    case "pdf":
      return "pdf";
    case "rs": case "ts": case "tsx": case "js": case "jsx": case "py": case "go":
    case "java": case "c": case "cpp": case "h": case "cs": case "rb": case "php":
    case "swift": case "kt": case "vue": case "sh": case "json": case "html": case "css":
      return "code";
    case "doc": case "docx":
      return "word";
    case "xls": case "xlsx": case "csv":
      return "excel";
    case "ppt": case "pptx":
      return "ppt";
    case "md": case "txt": case "rtf":
      return "text";
    default:
      return "generic";
  }
}
