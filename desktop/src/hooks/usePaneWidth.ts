import { useEffect, useState, type RefObject } from "react";

/**
 * ペインの実幅を購読する。分割数を増やすと 1 ペインが数百 px まで狭くなり、
 * ツールバー・フィルタチップ・列がそのままでは収まらないため、
 * 「ウィンドウ幅」ではなく「このペインの幅」で見た目を切り替える必要がある。
 *
 * ResizeObserver なので、分割の追加・削除だけでなくスプリッタのドラッグにも追従する。
 */
export function usePaneWidth(ref: RefObject<HTMLElement | null>): number {
  // 初期値は「広い」扱い。測る前に一瞬コンパクト表示になってちらつくのを防ぐ。
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") {
        // 小数のゆらぎで再レンダーが走らないよう整数に丸める。
        setWidth((prev) => (Math.round(prev) === Math.round(w) ? prev : w));
      }
    });
    observer.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/**
 * ペイン幅から決まる密度。
 *  - comfortable: 通常（ラベル付きチップ・全ツールバー）
 *  - compact:     チップをアイコンのみに、副次的なツールバーを畳む
 *  - minimal:     さらに詰める（3×4 分割のような極端に狭いペイン）
 *
 * 閾値は実測から決めている。フィルタチップ 7 個をラベル付きで並べると
 * 約 460px 必要で、それを割ると末尾のラベルが切れて読めなくなる。
 */
export type PaneDensity = "comfortable" | "compact" | "minimal";

export function paneDensity(width: number): PaneDensity {
  if (width < 320) return "minimal";
  if (width < 480) return "compact";
  return "comfortable";
}
