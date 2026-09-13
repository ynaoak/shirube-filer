// シンタックスハイライトのトークン別カスタム色（設定）を、
// .kf-code-view が参照する CSS 変数へ変換するヘルパー。
import type React from "react";

export const HL_TOKEN_KEYS = [
  "bg", "fg", "keyword", "string", "comment",
  "number", "function", "type", "attr", "meta",
] as const;
export type HlTokenKey = (typeof HL_TOKEN_KEYS)[number];

const VAR_MAP: Record<HlTokenKey, string> = {
  bg: "--hl-bg", fg: "--hl-fg", keyword: "--hl-kw", string: "--hl-str",
  comment: "--hl-cmt", number: "--hl-num", function: "--hl-fn",
  type: "--hl-type", attr: "--hl-attr", meta: "--hl-meta",
};

/** カスタム色をインライン CSS 変数へ（未設定トークンは含めない＝既定のまま）。 */
export function hlColorsToStyle(colors: Record<string, string>): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const key of HL_TOKEN_KEYS) {
    const v = colors[key];
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) style[VAR_MAP[key]] = v;
  }
  return style as React.CSSProperties;
}
