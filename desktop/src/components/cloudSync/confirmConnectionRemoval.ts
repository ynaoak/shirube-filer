type ConfirmRemoval = (message: string) => boolean;

/**
 * クラウド接続は、確認ポップアップで決定された場合にだけ削除する。
 */
export function confirmConnectionRemoval(
  message: string,
  remove: () => void,
  confirmRemoval: ConfirmRemoval = window.confirm,
) {
  if (!confirmRemoval(message)) return;
  remove();
}
