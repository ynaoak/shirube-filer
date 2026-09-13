import { useCallback } from "react";
import { useKeybindings, matchBinding } from "../store/keybindingStore";
import { FileEntry } from "../types/fs";

type Params = {
  entries: FileEntry[];
  focusedIndex: number;
  setFocusedIndex: (idx: number) => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onOpen: (entry: FileEntry) => void;
  onNavigateUp: () => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (paths: string[]) => void;
  onCopy: (paths: string[]) => void;
  onCut: (paths: string[]) => void;
  onPaste: () => void;
  onFocusSearch: () => void;
  onRefresh: () => void;
  onShowProperties: (entry: FileEntry) => void;
  onCopyPath: (paths: string[]) => void;
  onRevealInExplorer: (path: string) => void;
  onAddBookmark: () => void;
  onQuickJump: (char: string) => void;
  onCopyToOtherPane?: (paths: string[]) => void;
  onMoveToOtherPane?: (paths: string[]) => void;
};

export function useFileListShortcuts({
  entries,
  focusedIndex,
  setFocusedIndex,
  selected,
  setSelected,
  onOpen,
  onNavigateUp,
  onRename,
  onDelete,
  onCopy,
  onCut,
  onPaste,
  onFocusSearch,
  onRefresh,
  onShowProperties,
  onCopyPath,
  onRevealInExplorer,
  onAddBookmark,
  onQuickJump,
  onCopyToOtherPane,
  onMoveToOtherPane,
}: Params) {
  const { bindings } = useKeybindings();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      const focused = entries[focusedIndex] ?? null;

      if (matchBinding(bindings, e, "file.selectUp")) {
        e.preventDefault();
        const next = Math.max(0, focusedIndex - 1);
        setFocusedIndex(next);
        if (entries[next]) setSelected(new Set([entries[next].path]));
        return;
      }

      if (matchBinding(bindings, e, "file.selectDown")) {
        e.preventDefault();
        const next = Math.min(entries.length - 1, focusedIndex + 1);
        setFocusedIndex(next);
        if (entries[next]) setSelected(new Set([entries[next].path]));
        return;
      }

      if (matchBinding(bindings, e, "file.open") && focused) {
        e.preventDefault();
        onOpen(focused);
        return;
      }

      if (matchBinding(bindings, e, "file.navigateUp")) {
        e.preventDefault();
        onNavigateUp();
        return;
      }

      if (matchBinding(bindings, e, "file.rename") && focused) {
        e.preventDefault();
        onRename(focused);
        return;
      }

      if (matchBinding(bindings, e, "file.delete") && selected.size > 0) {
        e.preventDefault();
        onDelete(Array.from(selected));
        return;
      }

      if (matchBinding(bindings, e, "file.refresh")) {
        e.preventDefault();
        onRefresh();
        return;
      }

      if (matchBinding(bindings, e, "file.properties") && focused) {
        e.preventDefault();
        onShowProperties(focused);
        return;
      }

      if (matchBinding(bindings, e, "clipboard.copy") && selected.size > 0) {
        e.preventDefault();
        onCopy(Array.from(selected));
        return;
      }

      if (matchBinding(bindings, e, "clipboard.cut") && selected.size > 0) {
        e.preventDefault();
        onCut(Array.from(selected));
        return;
      }

      if (matchBinding(bindings, e, "clipboard.paste")) {
        e.preventDefault();
        onPaste();
        return;
      }

      if (matchBinding(bindings, e, "search.open")) {
        e.preventDefault();
        onFocusSearch();
        return;
      }

      if (matchBinding(bindings, e, "file.copyPath") && selected.size > 0) {
        e.preventDefault();
        onCopyPath(Array.from(selected));
        return;
      }

      if (matchBinding(bindings, e, "file.revealInExplorer") && focused) {
        e.preventDefault();
        onRevealInExplorer(focused.path);
        return;
      }

      if (matchBinding(bindings, e, "file.addBookmark")) {
        e.preventDefault();
        onAddBookmark();
        return;
      }

      // F5: コピー to other pane (compare mode)
      if (e.key === "F5" && !e.ctrlKey && !e.metaKey && onCopyToOtherPane && selected.size > 0) {
        e.preventDefault();
        onCopyToOtherPane(Array.from(selected));
        return;
      }

      // F6: 移動 to other pane (compare mode)
      if (e.key === "F6" && !e.ctrlKey && !e.metaKey && onMoveToOtherPane && selected.size > 0) {
        e.preventDefault();
        onMoveToOtherPane(Array.from(selected));
        return;
      }

      // Quick jump: printable single character with no modifier keys
      if (
        e.key.length === 1 &&
        !e.ctrlKey && !e.metaKey && !e.altKey
      ) {
        onQuickJump(e.key);
        return;
      }
    },
    [
      bindings, entries, focusedIndex, selected,
      setFocusedIndex, setSelected,
      onOpen, onNavigateUp, onRename, onDelete, onCopy, onCut, onPaste,
      onFocusSearch, onRefresh, onShowProperties, onCopyPath, onRevealInExplorer, onAddBookmark, onQuickJump,
      onCopyToOtherPane, onMoveToOtherPane,
    ]
  );

  return { handleKeyDown };
}
