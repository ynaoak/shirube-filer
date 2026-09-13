import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * 一覧から他アプリ（エクスプローラー、メーラー、エディタ等）へファイルを
 * 引き出すための OS ネイティブなドラッグ。
 *
 * なぜ要るか: WebView の HTML5 ドラッグはページの中で完結していて、OS に
 * 「掴んでいるのはこのファイルだ」と伝える手段が無い。dataTransfer に
 * text/uri-list を積んでもエクスプローラーは CF_HDROP しか受け取らないため、
 * 外へ落としても何も起きなかった。tauri-plugin-drag 経由で OS のドラッグ
 * セッション（Windows: DoDragDrop / macOS: NSDraggingSession / Linux: GTK）を
 * 開始する。
 *
 * 切り替えは dragstart の時点で行う（preventDefault + start_drag）。
 * HTML5 ドラッグ自体が WebView プロセスの OS ドラッグとして走るため、
 * 進行中に 2 本目の OS ドラッグを足すことはできない（ウィンドウ外へ出た
 * ときに引き継ぐ方式はこれで失敗した）。drag-rs 本家の例もこの形。
 *
 * OS のドラッグでは dataTransfer が使えない。アプリ内の移動（別ペイン・
 * フォルダへのドロップ）は dataTransfer に積んだ JSON を読んでいるため、
 * 掴んだ内容をここにも控えておき、内部のドロップ処理は dataTransfer が
 * 空でもこちらを読めるようにしてある（OS ドラッグが自ウィンドウへ入ると
 * WebView が HTML5 の dragover / drop を発火するので、経路自体は生きる）。
 */

export type InternalDragPayload = {
  srcPath: string;
  srcPaths: string[];
  srcPaneId: string;
};

/** 内部 D&D で使う MIME。ネイティブドラッグでも同じ形の値を控える。 */
export const INTERNAL_DRAG_TYPE = "application/shirube-file";

/** 進行中のドラッグ内容。ネイティブドラッグ中は dataTransfer が空になるため。 */
let active: InternalDragPayload | null = null;
/** 控えを置いた時刻。取りこぼしたときに無期限で残らないようにするため。 */
let activeAt = 0;

/**
 * 控えの有効期限。
 *
 * 控えの解除はプラグインの終了イベント頼みで、それが届かなければ（ウィンドウが
 * 閉じた・プラグイン側で失敗した等）いつまでも残る。残ったまま他アプリから
 * ファイルをドロップされると isInternalDrag が真になり、readInternalDrag が
 * 古いパスを返して「ドロップした物ではなく前に掴んでいた物」が移動される。
 * ドラッグの操作は数十秒も続かないので、それを過ぎたら無かったことにする。
 */
const ACTIVE_MAX_AGE_MS = 30_000;

export function setActiveDrag(payload: InternalDragPayload): void {
  active = payload;
  activeAt = Date.now();
}

export function clearActiveDrag(): void {
  active = null;
  activeAt = 0;
}

/** 期限切れの控えを捨てたうえで現在の控えを返す。 */
function currentActive(): InternalDragPayload | null {
  if (active !== null && Date.now() - activeAt > ACTIVE_MAX_AGE_MS) {
    clearActiveDrag();
  }
  return active;
}

/**
 * DataTransfer から内部ドラッグの内容を読む。
 * ネイティブドラッグ中は dataTransfer に何も無いので、控えたほうを使う。
 */
export function readInternalDrag(dataTransfer: DataTransfer): InternalDragPayload | null {
  const raw = dataTransfer.getData(INTERNAL_DRAG_TYPE);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<InternalDragPayload>;
      if (parsed.srcPaths?.length || parsed.srcPath) {
        return {
          srcPath: parsed.srcPath ?? parsed.srcPaths![0],
          srcPaths: parsed.srcPaths?.length ? parsed.srcPaths : [parsed.srcPath!],
          srcPaneId: parsed.srcPaneId ?? "",
        };
      }
    } catch {
      // 壊れた JSON は無いものとして扱い、控えたほうへ落とす。
    }
  }
  return currentActive();
}

/**
 * ドロップ先として受け付けてよいドラッグかどうか。
 *
 * 通常の HTML5 ドラッグでは MIME で判定できるが、ネイティブドラッグ中は
 * 型が "Files" になるため、自分が始めたドラッグかどうかで判定する。
 */
export function isInternalDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(INTERNAL_DRAG_TYPE) || currentActive() !== null;
}

/**
 * 内部ドラッグを受けるときに dragover で設定すべき dropEffect。
 *
 * HTML5 ドラッグ（自前 MIME を持つ）は effectAllowed が copyMove なので
 * "move" でよい。ネイティブドラッグは copy のみ許可で開始しており
 * （エクスプローラーへ落としたとき勝手に移動されないため）、そこへ "move" を
 * 返すと drag operation が none になり drop 自体が発火しなくなる。
 */
export function internalDropEffect(dataTransfer: DataTransfer): "move" | "copy" {
  return dataTransfer.types.includes(INTERNAL_DRAG_TYPE) ? "move" : "copy";
}

/** ネイティブドラッグが使えるか（Tauri の外＝ブラウザのデモでは使えない）。 */
function inTauri(): boolean {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false;
  // E2E は __TAURI_INTERNALS__ をモックするためここでは区別できない。
  // Playwright の合成 D&D はネイティブドラッグを再現できないので、モックが
  // 立てるマーカーを見て HTML5 経路に留まる（実アプリでは常に未定義）。
  return !("__TAURI_E2E_MOCK__" in window);
}

/**
 * この一式を OS のドラッグに載せられるか。
 *
 * ドラッグの途中（dragleave）で同期に判定できる必要があるため、実際に開始する
 * startNativeFileDrag とは別に切り出してある。
 */
export function canStartNativeDrag(paths: string[]): boolean {
  if (!inTauri() || paths.length === 0) return false;
  // mtp:// のような仮想パスは OS から見えるファイルではないので渡せない。
  return paths.every((p) => /^([a-zA-Z]:[\\/]|[\\/])/.test(p));
}

/**
 * ドラッグのプレビュー画像を PNG データ URL で作る。
 *
 * プラグインは PNG を要求するため、DOM のカードをそのまま渡せない。
 * ファイル名（と複数選択なら件数）だけの小さな札を canvas で描く。
 */
function buildDragPreview(label: string, count: number): string {
  const dpr = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const text = count > 1 ? `${label}  +${count - 1}` : label;
  const pad = 10;
  const fontSize = 12;

  const measure = document.createElement("canvas").getContext("2d");
  let width = 160;
  if (measure) {
    measure.font = `${fontSize}px sans-serif`;
    width = Math.min(320, Math.ceil(measure.measureText(text).width) + pad * 2);
  }
  const height = 28;

  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(dpr, dpr);

  // 背景（角丸）。OS 側の合成に任せるので影は付けない。
  ctx.fillStyle = "rgba(32,32,36,0.92)";
  const r = 6;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(width, 0, width, height, r);
  ctx.arcTo(width, height, 0, height, r);
  ctx.arcTo(0, height, 0, 0, r);
  ctx.arcTo(0, 0, width, 0, r);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#f2f2f2";
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(text, pad, height / 2 + 1);

  return canvas.toDataURL("image/png");
}

/** canvas が使えない環境向けの 1x1 透明 PNG。プラグインは PNG を必須とする。 */
const BLANK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * OS のドラッグセッションを開始する。
 *
 * 戻り値は「開始できたか」。
 */
async function startNativeFileDrag(paths: string[], label: string): Promise<boolean> {
  try {
    // プラグインは進捗の通知先を必ず要求する。ここで受けるのは終了の合図だけで、
    // 実際のコピーは落とし先のアプリが行う。
    const onEvent = new Channel<{ result: string; cursorPos: { x: number; y: number } }>();
    onEvent.onmessage = () => {
      // Dropped / Cancel のどちらでもセッションは終わり。控えを片付ける。
      // ただし即消しはしない: このイベントと自ウィンドウへの DOM drop は別経路で
      // 届き順序保証が無く、先に消すと内部ドロップが控えを読めなくなる。
      // 次のドラッグは dragstart で控えを上書きするので、遅れても害は無い。
      setTimeout(clearActiveDrag, 300);
    };

    await invoke("plugin:drag|start_drag", {
      item: paths,
      image: buildDragPreview(label, paths.length) || BLANK_PNG,
      options: { mode: "copy" },
      onEvent,
    });
    return true;
  } catch (e) {
    console.error("[native drag]", e);
    clearActiveDrag();
    return false;
  }
}

/**
 * dragstart で HTML5 のドラッグを止め、OS のドラッグに差し替える。
 *
 * 戻り値は「差し替えたか」。false なら呼び出し側は従来どおり HTML5 の
 * ドラッグを組み立てる（ブラウザのデモ・E2E・仮想パスのとき）。
 *
 * 以前は「ポインタがウィンドウの外へ出たら OS のドラッグへ引き継ぐ」方式
 * だったが、機能しなかった。(1) Chromium はウィンドウ外へ出たときの
 * dragleave を「最後に内側で観測した座標」で発火するため、縁ぴったりの
 * 座標判定がまず成立しない。(2) HTML5 ドラッグ自体が WebView プロセスの
 * OS ドラッグ（Windows では DoDragDrop）として走っており、進行中に 2 本目を
 * 開始するとマウスキャプチャの取り合いになって、まともなドロップが届かない。
 *
 * アプリ内の移動は失われない: OS のドラッグが自ウィンドウへ入ると WebView が
 * HTML5 の dragover / drop を発火し（dragDropEnabled: false のため素通し）、
 * 内部のドロップ処理は dataTransfer が空でも控え（active）を読む。
 */
export function beginNativeFileDrag(
  e: { preventDefault(): void },
  payload: InternalDragPayload,
  label: string
): boolean {
  if (!canStartNativeDrag(payload.srcPaths)) return false;
  // HTML5 のドラッグを始めさせない。ここで止めた gesture に dragend は来ない
  // ので、控えの後片付けはプラグインの終了イベント（上の onEvent）が担う。
  e.preventDefault();
  setActiveDrag(payload);
  void startNativeFileDrag(payload.srcPaths, label);
  return true;
}
