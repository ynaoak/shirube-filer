import type { FileEntry } from "../types/fs";
import { fileIconSpec, fileIconKind } from "../components/fileList/fileIconSpec";
import { dimensionalIconArt, DIMENSIONAL_ICON_VIEWBOX } from "../components/fileList/dimensionalIconArt";
import { getCachedEmbeddedIcon } from "./embeddedIcons";
import type { IconSet } from "../store/uiSettingsStore";

/**
 * ドラッグ中にカーソルへ追従する画像を差し替える。
 *
 * 既定では WebView が「掴んだ行そのもの」を半透明のビットマップにして出すため、
 * 一覧の行幅いっぱいの四角い枠が付いてくる。ここではファイル種別のアイコンと
 * 名前だけの小さなカードを作り、dataTransfer.setDragImage() で差し替える。
 *
 * 制約:
 *  - setDragImage は dragstart の中で同期的に呼ぶ必要がある（後から差し替え不可）
 *  - 渡す要素は DOM に入っていて描画可能でないとスナップショットが空になる。
 *    そのため画面外（left: -10000px）に置き、撮り終わる次のタイックで消す。
 */
export function applyFileDragImage(
  dataTransfer: DataTransfer,
  entry: FileEntry,
  count: number,
  iconSet: IconSet = "material"
): void {
  // setDragImage 非対応（古い環境やテストの簡易 DataTransfer）では何もしない。
  if (typeof dataTransfer.setDragImage !== "function") return;

  const card = buildCard(entry, count, iconSet);
  document.body.appendChild(card);
  // カーソルはカードの少し内側に置く（Finder / Explorer と同じ持ち方）。
  dataTransfer.setDragImage(card, 18, 16);
  // スナップショットは同期的に撮られるので、次のタスクで撤去して問題ない。
  setTimeout(() => card.remove(), 0);
}

/** 見た目確認・テスト用に、差し替えるカードだけを組み立てる。 */
export function buildCard(entry: FileEntry, count: number, iconSet: IconSet = "material"): HTMLElement {
  const card = document.createElement("div");
  card.dataset.fileDragImage = "true";
  Object.assign(card.style, {
    position: "fixed",
    top: "0",
    left: "-10000px",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    maxWidth: "260px",
    padding: "5px 10px 5px 8px",
    borderRadius: "6px",
    backgroundColor: "var(--kf-bg-secondary)",
    border: "1px solid var(--kf-border)",
    boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
    color: "var(--kf-text-primary)",
    fontSize: "12px",
    lineHeight: "1",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  } as Partial<CSSStyleDeclaration>);

  card.appendChild(buildIcon(entry, iconSet));

  const label = document.createElement("span");
  label.textContent = entry.name;
  Object.assign(label.style, {
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "180px",
  } as Partial<CSSStyleDeclaration>);
  card.appendChild(label);

  // 複数選択のときは残りの件数をバッジで添える（何個運んでいるか分かるように）。
  if (count > 1) {
    const badge = document.createElement("span");
    badge.dataset.dragCount = String(count);
    badge.textContent = String(count);
    Object.assign(badge.style, {
      minWidth: "16px",
      height: "16px",
      padding: "0 4px",
      borderRadius: "8px",
      backgroundColor: "var(--kf-accent)",
      color: "var(--kf-accent-fg, #fff)",
      fontSize: "10px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(badge);
  }

  return card;
}

/**
 * 種別アイコン。一覧（FileIcon）と同じ順序で選ぶ。
 * ここが一覧と食い違うと、掴んだ瞬間に絵柄が変わって別物を運んでいるように見える。
 */
function buildIcon(entry: FileEntry, iconSet: IconSet): Element {
  const embedded = getCachedEmbeddedIcon(entry, iconSet === "system");
  if (embedded) {
    const img = document.createElement("img");
    img.src = embedded;
    img.alt = "";
    Object.assign(img.style, {
      width: "16px",
      height: "16px",
      objectFit: "contain",
      flexShrink: "0",
    } as Partial<CSSStyleDeclaration>);
    return img;
  }

  if (iconSet === "dimensional") {
    return buildDimensionalIcon(entry);
  }

  const spec = fileIconSpec(entry);
  const icon = document.createElement("span");
  // 一覧のアイコンと同じ Material Symbols を使う（クラスでフォントが当たる）。
  icon.className = "material-symbols-rounded";
  icon.dataset.iconName = spec.name;
  icon.textContent = spec.name;
  Object.assign(icon.style, {
    fontSize: "16px",
    color: spec.color,
    flexShrink: "0",
  } as Partial<CSSStyleDeclaration>);
  return icon;
}

/** ドラッグ画像の連番。グラデーション id の衝突を避けるためだけに使う。 */
let dimensionalIconSeq = 0;

/**
 * 立体アイコンを素の DOM で組み立てる。
 *
 * 一覧側は React の DimensionalIcon が描くが、このカードは React の外にあるため
 * 同じ絵柄データ（dimensionalIconArt）から手で SVG 要素を作る。SVG は HTML と
 * 名前空間が違うので createElementNS が要る。
 */
function buildDimensionalIcon(entry: FileEntry): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const art = dimensionalIconArt(fileIconKind(entry), `drag${(dimensionalIconSeq += 1)}`);

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", DIMENSIONAL_ICON_VIEWBOX);
  svg.setAttribute("aria-hidden", "true");
  svg.style.flexShrink = "0";
  svg.style.display = "block";

  const defs = document.createElementNS(NS, "defs");
  for (const g of art.gradients) {
    const grad = document.createElementNS(NS, "linearGradient");
    grad.setAttribute("id", g.id);
    grad.setAttribute("x1", String(g.x1));
    grad.setAttribute("y1", String(g.y1));
    grad.setAttribute("x2", String(g.x2));
    grad.setAttribute("y2", String(g.y2));
    for (const s of g.stops) {
      const stop = document.createElementNS(NS, "stop");
      stop.setAttribute("offset", String(s.offset));
      stop.setAttribute("stop-color", s.color);
      if (s.opacity !== undefined) stop.setAttribute("stop-opacity", String(s.opacity));
      grad.appendChild(stop);
    }
    defs.appendChild(grad);
  }
  svg.appendChild(defs);

  for (const s of art.shapes) {
    if (s.tag === "path") {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", s.d);
      if (s.fill !== undefined) path.setAttribute("fill", s.fill);
      if (s.opacity !== undefined) path.setAttribute("opacity", String(s.opacity));
      if (s.stroke !== undefined) {
        path.setAttribute("stroke", s.stroke);
        path.setAttribute("stroke-linecap", "round");
      }
      if (s.strokeWidth !== undefined) path.setAttribute("stroke-width", String(s.strokeWidth));
      svg.appendChild(path);
    } else {
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", String(s.x));
      rect.setAttribute("y", String(s.y));
      rect.setAttribute("width", String(s.width));
      rect.setAttribute("height", String(s.height));
      rect.setAttribute("rx", String(s.rx));
      rect.setAttribute("fill", s.fill);
      if (s.opacity !== undefined) rect.setAttribute("opacity", String(s.opacity));
      svg.appendChild(rect);
    }
  }

  return svg;
}
