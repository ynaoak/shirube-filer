interface Props {
  /** 表示する行数 */
  rows?: number;
  /** 行の高さ(px) */
  rowHeight?: number;
  /** 各行に2本目の短いバー（サブテキスト想定）を出すか */
  twoLine?: boolean;
  className?: string;
}

/**
 * 一覧読み込み中のスケルトンプレースホルダ。
 * スピナーより「これから項目が並ぶ」というレイアウトを先に示せるため
 * 体感速度が上がる。`skeleton-shimmer`（App.css）でシマーアニメーション。
 */
export default function SkeletonList({
  rows = 6,
  rowHeight = 32,
  twoLine = false,
  className = "",
}: Props) {
  return (
    <div className={`flex flex-col gap-2 px-3 py-2 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2" style={{ minHeight: rowHeight }}>
          <div className="skeleton-shimmer shrink-0" style={{ width: 16, height: 16, borderRadius: 4 }} />
          <div className="flex flex-col gap-1 flex-1">
            <div
              className="skeleton-shimmer"
              style={{ height: 9, width: `${55 + ((i * 13) % 35)}%` }}
            />
            {twoLine && (
              <div
                className="skeleton-shimmer"
                style={{ height: 7, width: `${30 + ((i * 17) % 25)}%`, opacity: 0.6 }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
