// ドラッグ中にカーソル追従する軽量ゴースト（DOM 直接操作）。
// React の再レンダーを介さず pointermove ごとに transform だけ更新する。

export type DragGhost = {
  move: (x: number, y: number) => void;
  destroy: () => void;
};

export function createDragGhost(text: string): DragGhost {
  const el = document.createElement("div");
  el.className = "kf-drag-ghost";
  el.textContent = text;
  document.body.appendChild(el);
  return {
    move(x: number, y: number) {
      el.style.transform = `translate(${x + 14}px, ${y + 16}px)`;
    },
    destroy() {
      el.remove();
    },
  };
}
