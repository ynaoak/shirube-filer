// FileList で共有する定数・型。
export const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "ico", "avif",
]);

export type OptionalCol = "size" | "modified" | "ext" | "type";
export const ALL_OPTIONAL_COLS: readonly OptionalCol[] = ["size", "modified", "ext", "type"];
