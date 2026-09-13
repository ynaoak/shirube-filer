import { createContext, useContext } from "react";

export type FileOp =
  | { type: "rename"; oldPath: string; newPath: string }
  | { type: "move"; srcPaths: string[]; destDir: string; originalDir: string }
  | { type: "copy"; srcPaths: string[]; destDir: string }
  | { type: "delete"; paths: string[] };

export type UndoContextValue = {
  push: (op: FileOp) => void;
  undo: () => FileOp | null;
  canUndo: boolean;
  redo: () => FileOp | null;
  canRedo: boolean;
};

export const UndoContext = createContext<UndoContextValue>({
  push: () => {},
  undo: () => null,
  canUndo: false,
  redo: () => null,
  canRedo: false,
});

export function useUndo() {
  return useContext(UndoContext);
}
