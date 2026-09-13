import type { FileIconKind } from "./fileIconSpec";

/**
 * 立体アイコンの絵柄を、描画方法に依存しないデータとして持つ。
 *
 * 一覧は React コンポーネント（DimensionalIcon）で描くが、ドラッグ中に
 * カーソルへ付いてくるカードは React の外で組み立てた素の DOM なので、
 * 同じ絵柄を2通りの方法で描く必要がある。JSX とテンプレート文字列に
 * 同じ図形を2度書くと必ず食い違うため、図形の定義はここに1つだけ置き、
 * 両者はこれを自分の形式に写すだけにする。
 *
 * 色はテーマ変数ではなく実物に寄せた固定色。フォルダは黄、PDF は赤、
 * というのは OS をまたいで共有された記号で、テーマの配色に合わせて
 * 変えてしまうと種類の見分けという本来の役割を失うため。明度はライト／
 * ダークどちらの背景でも沈まない範囲に収めている。
 */

/** 種別ごとの基調色（濃い側 / 淡い側）。 */
export const DIMENSIONAL_PALETTE: Record<FileIconKind, { dark: string; light: string }> = {
  folder:  { dark: "#E8971A", light: "#FFD34D" },
  link:    { dark: "#6B7280", light: "#9CA3AF" },
  image:   { dark: "#0E9F6E", light: "#3DDC97" },
  video:   { dark: "#B44BC8", light: "#D67BE8" },
  audio:   { dark: "#E0761B", light: "#FFB057" },
  archive: { dark: "#B08300", light: "#E8C447" },
  pdf:     { dark: "#C42B1C", light: "#F2564A" },
  code:    { dark: "#2563EB", light: "#60A5FA" },
  word:    { dark: "#185ABD", light: "#4A90E2" },
  excel:   { dark: "#107C41", light: "#4CC38A" },
  ppt:     { dark: "#C43E1C", light: "#F2795A" },
  text:    { dark: "#5B6472", light: "#94A3B8" },
  generic: { dark: "#7A8598", light: "#AEB8C7" },
};

export type GradientStop = { offset: number; color: string; opacity?: number };

export type Gradient = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
};

export type Shape =
  | {
      tag: "path";
      d: string;
      fill?: string;
      opacity?: number;
      stroke?: string;
      strokeWidth?: number;
    }
  | {
      tag: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      rx: number;
      fill: string;
      opacity?: number;
    };

export type DimensionalIconArt = {
  gradients: Gradient[];
  shapes: Shape[];
};

/** 表示領域。両方の描画側で viewBox に使う。 */
export const DIMENSIONAL_ICON_VIEWBOX = "0 0 24 24";

/**
 * 種別ごとの絵柄を組み立てる。
 *
 * `uid` はグラデーションの id に混ぜる接尾辞。同じページに複数描かれると
 * id が衝突して他のアイコンの色を拾ってしまうため、呼び出し側で一意な値を渡す。
 */
export function dimensionalIconArt(kind: FileIconKind, uid: string): DimensionalIconArt {
  const c = DIMENSIONAL_PALETTE[kind];

  if (kind === "folder") {
    const back = `fb-${uid}`;
    const front = `ff-${uid}`;
    const vertical = { x1: 0, y1: 0, x2: 0, y2: 1 };
    return {
      gradients: [
        { id: back, ...vertical, stops: [{ offset: 0, color: c.light }, { offset: 1, color: c.dark }] },
        { id: front, ...vertical, stops: [{ offset: 0, color: c.light }, { offset: 1, color: c.dark }] },
      ],
      shapes: [
        // 奥のパーツ（タブ付き）。手前より暗くして奥行きを出す。
        {
          tag: "path",
          d: "M2 6.5A2.5 2.5 0 0 1 4.5 4h4.2c.5 0 1 .2 1.4.6L12 6h7.5A2.5 2.5 0 0 1 22 8.5V10H2z",
          fill: `url(#${back})`,
          opacity: 0.75,
        },
        // 手前のパーツ。上端をわずかに明るくして光を受けた面にする。
        {
          tag: "path",
          d: "M2 9h20v8.5a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5z",
          fill: `url(#${front})`,
        },
        { tag: "path", d: "M2 9h20v1.2H2z", fill: "#fff", opacity: 0.35 },
        {
          tag: "path",
          d: "M2 18.6h20v-1.1a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5z",
          fill: "#000",
          opacity: 0.08,
        },
      ],
    };
  }

  if (kind === "link") {
    const g = `lg-${uid}`;
    return {
      gradients: [
        { id: g, x1: 0, y1: 0, x2: 0, y2: 1, stops: [{ offset: 0, color: c.light }, { offset: 1, color: c.dark }] },
      ],
      shapes: [
        {
          tag: "path",
          d: "M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5",
          fill: "none",
          stroke: `url(#${g})`,
          strokeWidth: 2.2,
        },
        {
          tag: "path",
          d: "M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5",
          fill: "none",
          stroke: `url(#${g})`,
          strokeWidth: 2.2,
        },
      ],
    };
  }

  // ── 紙もの（ファイル）─────────────────────────────────────────────
  // 一覧では 16px で描かれるため、白い紙に小さな色帯を添えるだけでは種別を
  // 見分けられない。紙面そのものを種別色にして色の面積を稼ぎ、折り返した角を
  // 濃くして厚みを出す。中の白い横線は「書かれた中身」を示す記号。
  const paper = `pg-${uid}`;
  const fold = `fg-${uid}`;
  return {
    gradients: [
      {
        id: paper,
        x1: 0, y1: 0, x2: 0.35, y2: 1,
        stops: [{ offset: 0, color: c.light }, { offset: 1, color: c.dark }],
      },
      {
        id: fold,
        x1: 0, y1: 0, x2: 0, y2: 1,
        stops: [
          { offset: 0, color: "#FFFFFF", opacity: 0.9 },
          { offset: 1, color: "#FFFFFF", opacity: 0.55 },
        ],
      },
    ],
    shapes: [
      // 紙本体。右上は折り返しのぶん欠ける。
      {
        tag: "path",
        d: "M5 3.6A1.6 1.6 0 0 1 6.6 2H14l5 5v13.4A1.6 1.6 0 0 1 17.4 22H6.6A1.6 1.6 0 0 1 5 20.4z",
        fill: `url(#${paper})`,
      },
      // 上端のハイライトと下端の陰で、平らな板ではなく厚みのある紙に見せる。
      { tag: "path", d: "M5 3.6A1.6 1.6 0 0 1 6.6 2H14v1.1H5z", fill: "#fff", opacity: 0.3 },
      {
        tag: "path",
        d: "M5 19.4h14v1A1.6 1.6 0 0 1 17.4 22H6.6A1.6 1.6 0 0 1 5 20.4z",
        fill: "#000",
        opacity: 0.12,
      },
      // 折り返した角。白く起こして裏面に見せ、境目に影を落とす。
      { tag: "path", d: "M14 2l5 5h-3.6A1.4 1.4 0 0 1 14 5.6z", fill: `url(#${fold})` },
      { tag: "path", d: "M14 2l5 5h-1.1L14 3.1z", fill: "#000", opacity: 0.14 },
      // 中身を示す横線。
      { tag: "rect", x: 7.6, y: 11.2, width: 8.8, height: 1.5, rx: 0.75, fill: "#fff", opacity: 0.85 },
      { tag: "rect", x: 7.6, y: 14.2, width: 8.8, height: 1.5, rx: 0.75, fill: "#fff", opacity: 0.85 },
      { tag: "rect", x: 7.6, y: 17.2, width: 5.6, height: 1.5, rx: 0.75, fill: "#fff", opacity: 0.85 },
    ],
  };
}
