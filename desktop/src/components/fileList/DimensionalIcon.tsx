import { useId } from "react";
import type { FileIconKind } from "./fileIconSpec";
import { dimensionalIconArt, DIMENSIONAL_ICON_VIEWBOX } from "./dimensionalIconArt";

/**
 * 立体的なファイル種別アイコン（SVG）。
 *
 * Material Symbols は単色のフォントアイコンで、輪郭だけのフラットな絵柄になる。
 * OS 標準のファイラーのアイコンは、フォルダなら手前のフラップが奥より明るく、
 * ファイルなら紙の右上が折れて影が落ちる、という「厚み」を持っている。
 * ここではそれをグラデーションとハイライトで再現する。
 *
 * 絵柄そのものは dimensionalIconArt.ts に持たせている。ドラッグ中にカーソルへ
 * 付いてくるカードは React の外で組み立てるため、同じ絵柄を2通りの方法で
 * 描く必要があり、図形を二重に書かないための分離。
 *
 * グラデーションの id は同一ページに複数描かれると衝突するので useId で一意にする。
 */

type Props = { kind: FileIconKind; size?: number };

export default function DimensionalIcon({ kind, size = 16 }: Props) {
  const uid = useId().replace(/:/g, "");
  const art = dimensionalIconArt(kind, uid);

  return (
    <svg
      width={size}
      height={size}
      viewBox={DIMENSIONAL_ICON_VIEWBOX}
      aria-hidden
      style={{ flexShrink: 0, display: "block" }}
    >
      <defs>
        {art.gradients.map((g) => (
          <linearGradient key={g.id} id={g.id} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
            {g.stops.map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {art.shapes.map((s, i) =>
        s.tag === "path" ? (
          <path
            key={i}
            d={s.d}
            fill={s.fill}
            opacity={s.opacity}
            stroke={s.stroke}
            strokeWidth={s.strokeWidth}
            strokeLinecap={s.stroke ? "round" : undefined}
          />
        ) : (
          <rect
            key={i}
            x={s.x}
            y={s.y}
            width={s.width}
            height={s.height}
            rx={s.rx}
            fill={s.fill}
            opacity={s.opacity}
          />
        )
      )}
    </svg>
  );
}
