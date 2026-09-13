import { useState, useEffect } from "react";
import { ClipboardItem } from "../types/fileListTypes";

let _clipboard: ClipboardItem | null = null;
const _listeners = new Set<(c: ClipboardItem | null) => void>();

function setSharedClipboard(item: ClipboardItem | null) {
  _clipboard = item;
  _listeners.forEach((fn) => fn(item));
}

export function useClipboard(): [ClipboardItem | null, (item: ClipboardItem | null) => void] {
  const [clipboard, setLocalClipboard] = useState<ClipboardItem | null>(_clipboard);

  useEffect(() => {
    // Sync with global state in case it changed before this component mounted
    setLocalClipboard(_clipboard);
    _listeners.add(setLocalClipboard);
    return () => {
      _listeners.delete(setLocalClipboard);
    };
  }, []);

  return [clipboard, setSharedClipboard];
}
