/**
 * ゴミ箱移動の失敗のうち「ゴミ箱そのものが使えない」ケースを見分けるための目印。
 *
 * Rust 側（src-tauri/src/windows_trash.rs）が、ゴミ箱が無効なドライブ・容量超過・
 * パスが長すぎる等でゴミ箱に入れられなかったときだけエラーメッセージに埋め込む。
 * 完全削除に切り替えれば成功する見込みがあるため、UI はこれを見て
 * 「完全に削除しますか？」と確認する。
 */
export const TRASH_UNAVAILABLE = "[TRASH_UNAVAILABLE]";

/** 目印を含むエラーか（ゴミ箱に入れられなかったか）。 */
export function isTrashUnavailable(message: string): boolean {
  return message.includes(TRASH_UNAVAILABLE);
}

/** 画面に出す前に目印を取り除く（ユーザーには意味のない文字列のため）。 */
export function stripTrashMarker(message: string): string {
  return message.split(TRASH_UNAVAILABLE).join("").trim();
}
