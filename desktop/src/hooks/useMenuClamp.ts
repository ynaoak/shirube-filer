import { useLayoutEffect, useRef, useState, RefObject } from "react";

/**
 * カーソル座標に出すカスタムメニューをウィンドウ内にクランプするフック。
 * マウント後に実サイズを測って位置を補正する（見切れ防止）。
 *
 * 使い方:
 *   const { ref, pos } = useMenuClamp(menu.x, menu.y);
 *   <div ref={ref} style={{ left: pos.x, top: pos.y, position: "fixed" }}>…</div>
 */
export function useMenuClamp(
  x: number,
  y: number
): { ref: RefObject<HTMLDivElement | null>; pos: { x: number; y: number } } {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setPos({ x, y });
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
    });
  }, [x, y]);

  return { ref, pos };
}
