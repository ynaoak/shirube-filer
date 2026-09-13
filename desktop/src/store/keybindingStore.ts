import { createContext, useContext } from "react";
import {
  KeyBinding,
  KeyDescriptor,
  ShortcutAction,
} from "../types/keybinding";
export type { KeybindingsConfig } from "../types/keybinding";

// 既定バインドは「Windows/Linux 用」と「macOS 用（meta 付き）」を同じ action に
// 併記する。matchKey は修飾キー完全一致なので併記しても取り違えは起きず、
// shortcutLabelFor が OS に合う方を選んで表示する。
//
// macOS 側は Finder の慣習に合わせる:
//   ⌘⌫ = ゴミ箱へ / ⌘↑ = 親フォルダ / ⌘↓ = 開く / ⌘R = 再読み込み / ⌘I = 情報を見る
// （Mac のキーボードで delete キーが送るのは "Backspace" のため、"Delete" だけ
//   だとゴミ箱へ送るショートカットが Mac で一切使えない。）
export const DEFAULT_BINDINGS: KeyBinding[] = [
  { action: "file.selectUp",   keys: [{ key: "ArrowUp" }],               description: "keybindings.selectPrev" },
  { action: "file.selectDown", keys: [{ key: "ArrowDown" }],             description: "keybindings.selectNext" },
  { action: "file.open",       keys: [{ key: "Enter" }, { key: "ArrowDown", meta: true }], description: "keybindings.open" },
  { action: "file.navigateUp", keys: [{ key: "Backspace" }, { key: "ArrowUp", meta: true }], description: "keybindings.navigateUp" },
  { action: "file.rename",     keys: [{ key: "F2" }],                    description: "keybindings.rename" },
  { action: "file.delete",     keys: [{ key: "Delete" }, { key: "Backspace", meta: true }], description: "keybindings.delete" },
  { action: "file.refresh",    keys: [{ key: "F5" }, { key: "r", meta: true }], description: "keybindings.refresh" },
  { action: "file.properties",        keys: [{ key: "F4" }, { key: "i", meta: true }],                     description: "keybindings.properties" },
  { action: "file.copyPath",          keys: [{ key: "c", ctrl: true, shift: true }, { key: "c", meta: true, shift: true }], description: "keybindings.copyPath" },
  { action: "file.revealInExplorer",  keys: [{ key: "e", ctrl: true, shift: true }, { key: "e", meta: true, shift: true }], description: "keybindings.revealInExplorer" },
  { action: "file.addBookmark",       keys: [{ key: "d", ctrl: true }, { key: "d", meta: true }], description: "keybindings.addBookmark" },
  { action: "clipboard.copy",  keys: [{ key: "c", ctrl: true }, { key: "c", meta: true }], description: "keybindings.copy" },
  { action: "clipboard.cut",   keys: [{ key: "x", ctrl: true }, { key: "x", meta: true }], description: "keybindings.cut" },
  { action: "clipboard.paste", keys: [{ key: "v", ctrl: true }, { key: "v", meta: true }], description: "keybindings.paste" },
  { action: "search.open",     keys: [{ key: "f", ctrl: true }, { key: "f", meta: true }], description: "keybindings.openSearch" },
  { action: "tab.new",         keys: [{ key: "t", ctrl: true }, { key: "t", meta: true }], description: "keybindings.newTab" },
  { action: "tab.close",       keys: [{ key: "w", ctrl: true }, { key: "w", meta: true }], description: "keybindings.closeTab" },
];

export function matchKey(
  desc: KeyDescriptor,
  e: KeyboardEvent | React.KeyboardEvent
): boolean {
  return (
    e.key === desc.key &&
    !!e.ctrlKey === !!desc.ctrl &&
    !!e.shiftKey === !!desc.shift &&
    !!e.altKey === !!desc.alt &&
    !!e.metaKey === !!desc.meta
  );
}

export function matchBinding(
  bindings: KeyBinding[],
  e: KeyboardEvent | React.KeyboardEvent,
  action: ShortcutAction
): boolean {
  const binding = bindings.find((b) => b.action === action);
  if (!binding) return false;
  return binding.keys.some((k) => matchKey(k, e));
}

/** 実行中が macOS かどうか（表示ラベルの切り替え用の同期判定）。
 *  navigator.platform は非推奨のため userAgent を見る。Tauri の WKWebView でも
 *  "Macintosh" を含むため、起動直後（get_platform の解決前）から正しく判定できる。 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.userAgent);
}

/** KeyDescriptor を表示用ラベルにする。
 *  macOS は記号のみを詰めて並べる（⇧⌘P）、それ以外は「Ctrl+Shift+P」形式。 */
export function formatKeyLabel(k: KeyDescriptor): string {
  const key = k.key.length === 1 ? k.key.toUpperCase() : k.key;
  if (isMacPlatform()) {
    // Apple の表記順（⌃⌥⇧⌘）に合わせる。
    return `${k.ctrl ? "⌃" : ""}${k.alt ? "⌥" : ""}${k.shift ? "⇧" : ""}${k.meta ? "⌘" : ""}${key}`;
  }
  const parts: string[] = [];
  if (k.ctrl) parts.push("Ctrl");
  if (k.meta) parts.push("Win");
  if (k.shift) parts.push("Shift");
  if (k.alt) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

/** 「主修飾キー + 文字」の表示ラベル（⌘F / Ctrl+F）。i18n の固定文字列に
 *  "Ctrl+F" を埋め込むと macOS で嘘になるため、UI からはこれを使う。 */
export function formatModCombo(key: string, opts: { shift?: boolean } = {}): string {
  return formatKeyLabel({ key, shift: opts.shift, ...(isMacPlatform() ? { meta: true } : { ctrl: true }) });
}

/** アクションの現在のバインドから、プラットフォームに合う表示用ショートカットを返す。
 *  （コンテキストメニューの右端に添えるヒント用。バインドが無ければ undefined） */
export function shortcutLabelFor(bindings: KeyBinding[], action: ShortcutAction): string | undefined {
  const b = bindings.find((x) => x.action === action);
  if (!b || b.keys.length === 0) return undefined;
  const isMac = isMacPlatform();
  const key = b.keys.find((k) => (isMac ? k.meta : !k.meta)) ?? b.keys[0];
  return formatKeyLabel(key);
}

export type KeybindingContextValue = {
  bindings: KeyBinding[];
  updateBinding: (action: ShortcutAction, keys: KeyDescriptor[]) => void;
  resetBindings: () => void;
  saveToFile: () => Promise<void>;
  loadFromFile: () => Promise<void>;
};

export const KeybindingContext = createContext<KeybindingContextValue | null>(null);

export function useKeybindings() {
  const ctx = useContext(KeybindingContext);
  if (!ctx) throw new Error("useKeybindings must be used within KeybindingProvider");
  return ctx;
}
