// ウィンドウ間タブ D&D（タブの切り離し / 別ウィンドウへの統合）のヘルパー。
//
// - タブをウィンドウ外にドロップ → そのタブだけを 1 ペーンとした新しいウィンドウを開く
// - 別ウィンドウの上にドロップ → 落とした先のペーンにタブを統合する
// - 切り離し元のウィンドウがタブ 0 になったら（子ウィンドウのみ）そのウィンドウを閉じる
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import type { Tab } from "../types/layout";
import { genId } from "../store/layoutStore";

/** メインウィンドウの label。これ以外は切り離し（子）ウィンドウとして扱う。 */
export const MAIN_WINDOW_LABEL = "main";

/** 別ウィンドウへタブを渡すためのイベント名。 */
export const TAB_IMPORT_EVENT = "kf://tab-import";

export type TabImportPayload = {
  tab: Tab;
  /** ドロップ時の OS カーソル座標（物理px）。受け手側でペーン特定に使う。 */
  cursorX: number;
  cursorY: number;
};

/** ドラッグ中、カーソル下の別ウィンドウへ「今この上をドラッグ中」と知らせるイベント名。 */
export const TAB_DRAG_OVER_EVENT = "kf://tab-drag-over";
/** カーソルがウィンドウ上から離れた／ドラッグが終わったことを知らせるイベント名。 */
export const TAB_DRAG_LEAVE_EVENT = "kf://tab-drag-leave";

export type TabDragOverPayload = {
  /** ゴーストに表示するタブ名 */
  title: string;
  /** OS カーソル座標（物理px）。受け手側でクライアント座標へ変換する。 */
  cursorX: number;
  cursorY: number;
};

type CursorHit = { label: string | null; x: number; y: number };

/** 現在のウィンドウが切り離し（子）ウィンドウかどうか。 */
export function isChildWindow(): boolean {
  try {
    return getCurrentWindow().label !== MAIN_WINDOW_LABEL;
  } catch {
    return false;
  }
}

/** 切り離し元の URL に付与するクエリ。子ウィンドウ側の初期化で参照する。 */
export function isTearoffWindow(): boolean {
  return new URLSearchParams(window.location.search).get("tearoff") === "1";
}

export type ExternalDropResult = "merged" | "newwindow" | "none";

/**
 * ドラッグ中にカーソル下の別ウィンドウへ drag-over / leave を通知するノーティファイア。
 * マウスは移動元ウィンドウにキャプチャされていて、移動先の DOM にはイベントが
 * 一切届かないため、移動先でドラッグ中の表示を出すにはイベントで知らせるしかない。
 *
 * - onMove(): pointermove ごとに呼ぶ（内部で ~80ms にスロットル）。
 *   カーソル下のウィンドウを window_at_cursor で調べ、対象へ over を送る。
 *   対象が変わったら前の対象へ leave を送る。
 * - clear(): カーソルが移動元ウィンドウ内に戻ったとき／ドラッグ終了時に呼ぶ。
 *   最後の対象へ leave を送って状態をリセットする。
 */
export function createCrossWindowDragNotifier(title: string) {
  let lastLabel: string | null = null;
  let inFlight = false;
  let lastCall = 0;
  let cleared = false;

  const sendLeave = (label: string) => {
    emitTo(label, TAB_DRAG_LEAVE_EVENT, {}).catch(() => {});
  };

  const notify = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const self = getCurrentWindow();
      const hit = await invoke<CursorHit>("window_at_cursor", { exclude: self.label });
      // 非同期の往復中に clear() された場合はゴーストを出さない
      const label = cleared ? null : hit.label;
      if (lastLabel && lastLabel !== label) sendLeave(lastLabel);
      if (label) {
        emitTo(label, TAB_DRAG_OVER_EVENT, {
          title,
          cursorX: hit.x,
          cursorY: hit.y,
        } satisfies TabDragOverPayload).catch(() => {});
      }
      lastLabel = label;
    } catch {
      /* ignore */
    } finally {
      inFlight = false;
    }
  };

  return {
    onMove() {
      cleared = false;
      const now = Date.now();
      if (now - lastCall < 80) return;
      lastCall = now;
      void notify();
    },
    clear() {
      cleared = true;
      if (lastLabel) {
        sendLeave(lastLabel);
        lastLabel = null;
      }
    },
  };
}

export type CrossWindowDragNotifier = ReturnType<typeof createCrossWindowDragNotifier>;

/** クラウドブラウザ → メインウィンドウへのファイルドロップ（＝ダウンロード依頼）。 */
export const CLOUD_FILE_DROP_EVENT = "kf://cloud-file-drop";
export type CloudFileDropPayload = {
  jobId: string;
  /** RemoteEntry 相当（name / remoteKey / isDir / size） */
  entry: { name: string; remoteKey: string; isDir: boolean; size: number };
  cursorX: number;
  cursorY: number;
};

/**
 * タブがウィンドウの外へドロップされたときの処理。
 * - カーソル下に別のアプリウィンドウがあれば、そのウィンドウへタブを送って統合する
 * - 何も無ければ、そのタブだけを持つ新しいウィンドウを開く
 * 戻り値が "merged" / "newwindow" のとき、呼び出し側はタブを元ウィンドウから取り除く。
 */
export async function handleExternalTabDrop(tab: Tab): Promise<ExternalDropResult> {
  const self = getCurrentWindow();

  let hit: CursorHit;
  try {
    hit = await invoke<CursorHit>("window_at_cursor", { exclude: self.label });
  } catch {
    return "none";
  }

  // 別のアプリウィンドウの上に落とした → そのウィンドウへ統合
  if (hit.label && hit.label !== self.label) {
    try {
      await emitTo(hit.label, TAB_IMPORT_EVENT, {
        tab,
        cursorX: hit.x,
        cursorY: hit.y,
      } satisfies TabImportPayload);
      return "merged";
    } catch {
      return "none";
    }
  }

  // 何も無い場所に落とした → 新しいウィンドウを 1 ペーンで開く
  const label = `main-${genId()}`;
  try {
    await invoke("stash_tearoff", { label, tab: JSON.stringify(tab) });
  } catch {
    return "none";
  }

  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    new WebviewWindow(label, {
      url: `${window.location.origin}/?tearoff=1`,
      title: tab.title || "Shirube-Filer",
      width: 800,
      height: 600,
      decorations: false,
      focus: true,
    });
    return "newwindow";
  } catch {
    return "none";
  }
}
