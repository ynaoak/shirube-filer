type Props = {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
};

/**
 * ターミナルアイコン。
 * 端末ウィンドウ本体をテーマの前景色（--kf-text-primary）で塗り、プロンプト（>_）は
 * 背景色（--kf-bg-primary）で抜く。これにより、
 *  - ライトモード: 黒い端末＋白いプロンプト
 *  - ダークモード: 白い端末＋黒いプロンプト
 * となり、どちらのテーマでも背景と高コントラストで視認できる。
 */
export default function TerminalIcon({ size = 16, className = "", style, title }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`select-none ${className}`}
      style={{ verticalAlign: "middle", flexShrink: 0, ...style }}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <rect x="2" y="4" width="20" height="16" rx="3" style={{ fill: "var(--kf-text-primary)" }} />
      <path
        d="M6.5 9.5 L10 12.5 L6.5 15.5"
        fill="none"
        style={{ stroke: "var(--kf-bg-primary)" }}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="11.5"
        y1="15.6"
        x2="15.5"
        y2="15.6"
        style={{ stroke: "var(--kf-bg-primary)" }}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
