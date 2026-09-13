/**
 * アクセント色の上に載せる文字色を選ぶ。
 *
 * ── なぜ「最大コントラスト」で選ばないか ────────────────────────────────
 * WCAG の相対輝度で単純に比べると、中間調の青・紫（#3b82f6 や #8B5CF6 など）
 * では白より濃色のほうが数値上は上に出る。しかし彩度の高い塗りの上に濃色の文字を
 * 置くと「色付きの背景に黒文字」に見えて読みづらく、OS やデザインシステムの
 * 慣習（macOS のアクセントボタン、Material の primary など）とも食い違う。
 *
 * そこで「白で十分なコントラスト（UI テキストの目安 3:1）が取れるなら白、
 * 取れないほど明るい色なら濃色」という選び方にする。淡いアクセント
 * （既定テーマの #7DD3FC など）では白が 1.7:1 まで落ちるため、そこは濃色を返す。
 */

/** UI テキストとして許容する最小コントラスト比（WCAG 2.1 の非テキスト/大きめ文字の基準）。 */
const MIN_CONTRAST = 3;

const WHITE = "#FFFFFF";
const DARK = "#0B1220";

function channel(hex: string, index: number): number {
  return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
}

/** sRGB の相対輝度（WCAG 2.1）。 */
export function relativeLuminance(hex: string): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return (
    0.2126 * lin(channel(hex, 0)) +
    0.7152 * lin(channel(hex, 1)) +
    0.0722 * lin(channel(hex, 2))
  );
}

/** 2 色のコントラスト比（1〜21）。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `background` の上に載せて読める文字色を返す。
 * 白で 3:1 以上取れるなら白、取れないなら濃色。
 */
export function readableTextOn(background: string): string {
  if (!/^#[0-9A-Fa-f]{6}$/.test(background)) return WHITE;
  return contrastRatio(WHITE, background) >= MIN_CONTRAST ? WHITE : DARK;
}
