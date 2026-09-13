type Props = {
  name: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
};

export default function Icon({ name, size = 16, className = "", style, title }: Props) {
  return (
    <span
      className={`material-symbols-rounded select-none ${className}`}
      style={{ fontSize: size, lineHeight: 1, verticalAlign: "middle", ...style }}
      aria-hidden={!title}
      title={title}
    >
      {name}
    </span>
  );
}
