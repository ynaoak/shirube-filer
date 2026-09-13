/**
 * Markdown ビューアを独立ウィンドウで開く。
 *
 * md ファイルはダブルクリック時にメインウィンドウ内のモーダルではなく
 * 自由に移動・リサイズできる別ウィンドウで表示する。同じファイルの
 * ビューアが既に開いていれば新規作成せずフォーカスする。
 */
export async function openMarkdownViewerWindow(path: string): Promise<void> {
  const { WebviewWindow, getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
  // ウィンドウラベルに使える文字は限られるため、パスは簡易ハッシュで識別する
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  const label = `md-viewer-${h.toString(36)}`;
  const windows = await getAllWebviewWindows();
  const existing = windows.find((w) => w.label === label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const fileName = path.split(/[\\/]/).pop() ?? path;
  new WebviewWindow(label, {
    url: `${window.location.origin}/?mode=md-viewer&path=${encodeURIComponent(path)}`,
    title: fileName,
    width: 900,
    height: 700,
    resizable: true,
    center: true,
  });
}
