/** Module-level drag state — avoids WebView2 dataTransfer.types unreliability during dragover. */
export const tabDnd = {
  current: null as { tabId: string; sourcePaneId: string } | null,
};
