type Props = {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
};

/**
 * Git アイコン（自作 SVG）。
 * 定番の「ブランチグラフ」モチーフ（メインラインの 2 ノード + 分岐先ノードを
 * カーブで接続）をラインスタイルで描いたオリジナル。既存の Material Symbols
 * （線幅 ~1.7 相当）とウェイトを揃えている。
 * stroke は currentColor のため、配置先の color（テーマ変数）にそのまま追従する。
 */
export default function GitIcon({ size = 16, className = "", style, title }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      className={`select-none ${className}`}
      style={{ verticalAlign: "middle", flexShrink: 0, ...style }}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {/* メインライン（上下ノードをつなぐ） */}
      <line x1="7" y1="7.7" x2="7" y2="16.3" />
      {/* 分岐カーブ（メインライン中程 → 右上ノード） */}
      <path d="M7 13.2 C 7 10, 17 12.8, 17 9.8" />
      {/* ノード（上・下・分岐先） */}
      <circle cx="7" cy="5.5" r="2.1" />
      <circle cx="7" cy="18.5" r="2.1" />
      <circle cx="17" cy="7.6" r="2.1" />
    </svg>
  );
}
