import { useEffect, useRef } from "react";

/**
 * ポップオーバーを「外側クリック / 外側へのフォーカス移動 / Escape」で閉じる。
 *
 * ── focusin を素直に見てはいけない理由（macOS の WKWebView） ────────────────
 * WebKit はボタンをクリックしてもそのボタンにフォーカスを移さない（macOS の
 * 慣習に合わせた挙動で、Chromium とはここが違う）。そのためポップアップ内に
 * フォーカス中の入力欄があると、中のボタンを押した瞬間に
 *
 *   mousedown(BUTTON) → focusout(INPUT) → focusin(ポップアップ外の祖先)
 *   → mouseup → ※ click は発火しない
 *
 * という順で「ポップアップ外への focusin」が起きる。これを外側扱いにすると
 * mousedown の時点でポップアップが unmount され、押したボタンが DOM から
 * 消えるので click ハンドラが一度も呼ばれない（＝ボタンが効かない）。
 *
 * そこで「ポップアップ内で押している最中の focusin」は無視する。外側を
 * 押した場合は onDown 側が閉じるので、閉じ漏れは起きない。
 *
 * @param active    ポップアップが開いているか
 * @param ref       ポップアップのルート要素
 * @param onDismiss 外側クリック / 外側フォーカスで閉じるときの処理
 * @param onEscape  Escape で閉じるときの処理（省略時は onDismiss）
 */
export function useDismissOnOutside(
  active: boolean,
  ref: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
  onEscape?: () => void
) {
  // ハンドラは毎レンダーで作り直される想定なので ref 経由で最新を読む。
  // こうしないと effect が毎レンダー貼り直され、下の pressing 状態が消える。
  const dismissRef = useRef(onDismiss);
  const escapeRef = useRef(onEscape);
  dismissRef.current = onDismiss;
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;

    // ポップアップ内でポインタを押している最中か（上記 WebKit 対策）。
    let pressingInside = false;

    const isOutside = (target: EventTarget | null) =>
      !!ref.current && !ref.current.contains(target as Node);

    const onDown = (e: MouseEvent) => {
      pressingInside = !isOutside(e.target);
      if (!pressingInside) dismissRef.current();
    };
    // click は mouseup の後（=ポップアップ内のボタンの onClick が走った後）に
    // window まで上がってくる。ここで押下状態を解除する。
    const onClick = () => {
      pressingInside = false;
    };
    const onFocusIn = (e: FocusEvent) => {
      if (pressingInside) return;
      if (isOutside(e.target)) dismissRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (escapeRef.current ?? dismissRef.current)();
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("click", onClick);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("click", onClick);
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKey);
    };
  }, [active, ref]);
}
