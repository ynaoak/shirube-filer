// クラウドブラウザウィンドウを開く共有ヘルパー。
// CloudSyncPanel と ActivityBar（ダイレクトアイコン）の両方から使う。
// 既に同じジョブのウィンドウが開いていればフォーカスするだけ。
export async function openCloudBrowserWindow(job: { id: string; name: string }): Promise<void> {
  const { WebviewWindow, getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
  const label = `cloud-browser-${job.id}`;
  const windows = await getAllWebviewWindows();
  const existing = windows.find((w) => w.label === label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(label, {
    url: `${window.location.origin}/?mode=cloud-browser&job=${job.id}`,
    title: job.name,
    width: 900,
    height: 640,
    resizable: true,
    center: true,
  });
}
