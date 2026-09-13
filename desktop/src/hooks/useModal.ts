import { useEffect, useRef } from "react";

/** モーダル内でフォーカス可能な要素のセレクタ */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

interface UseModalOptions {
  /** Esc / フォーカストラップ脱出時に呼ばれる閉じる処理 */
  onClose?: () => void;
  /** Esc キーで閉じるか（既に独自の Esc 処理がある場合は false にして二重発火を防ぐ）。既定 true */
  closeOnEsc?: boolean;
  /** マウント時に最初のフォーカス可能要素へフォーカスするか。既定 true */
  autoFocus?: boolean;
  /** アンマウント時に直前のフォーカス位置へ戻すか。既定 true */
  restoreFocus?: boolean;
}

/**
 * モーダルダイアログのアクセシビリティを 1 フックに集約する。
 *  - フォーカストラップ（Tab / Shift+Tab がダイアログ外へ逃げない）
 *  - マウント時の初期フォーカス、アンマウント時のフォーカス復帰
 *  - Esc キーでのクローズ
 *
 * 返り値の ref をダイアログ本体（`role="dialog"` を付与する要素）に渡す。
 *
 * ```tsx
 * const dialogRef = useModal<HTMLDivElement>({ onClose });
 * return <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="...">…</div>;
 * ```
 */
export function useModal<T extends HTMLElement = HTMLDivElement>(
  options: UseModalOptions = {},
) {
  const { onClose, closeOnEsc = true, autoFocus = true, restoreFocus = true } = options;
  const ref = useRef<T>(null);

  // onClose はインライン関数で渡されることが多く、毎レンダーで identity が変わる。
  // これをエフェクトの依存に入れると、親の再レンダーのたびにエフェクトが再実行され
  // autoFocus が先頭要素（多くの場合ヘッダの閉じるボタン）へフォーカスを奪ってしまう。
  // 最新のハンドラは ref 経由で参照し、エフェクト自体はマウント時のみ実行する。
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (autoFocus && node) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      // フォーカス可能要素が無ければコンテナ自身に当てる（tabIndex=-1 を想定）
      (first ?? node).focus({ preventScroll: true });
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEsc && onCloseRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;

      const focusables = Array.from(
        node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      if (focusables.length === 0) {
        e.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const insideModal = node.contains(active);

      if (e.shiftKey) {
        if (active === first || active === node || !insideModal) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last || !insideModal) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (restoreFocus && previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [closeOnEsc, autoFocus, restoreFocus]);

  return ref;
}
