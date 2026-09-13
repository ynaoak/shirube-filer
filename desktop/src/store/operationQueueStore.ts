import { createContext, useContext } from "react";

export type QueueOp =
  | { type: "copy"; src: string; dest: string; overwrite: boolean }
  | { type: "move"; src: string; dest: string; overwrite: boolean }
  | { type: "delete"; path: string; trash: boolean }
  /** MTP（スマホ等）からローカルへの取り出し。src は mtp:// の仮想パス。
   *  MTP は読み取り専用なので移動ではなくダウンロード（コピー）になる。 */
  /** overwrite: 取り出し先を上書きしてよいか。衝突ダイアログで「上書き」を
   *  選んだときだけ true。既定は false で、Rust 側が既存ファイルを守る。 */
  | { type: "mtpDownload"; src: string; dest: string; overwrite: boolean };

export type QueueItemStatus = "pending" | "running" | "done" | "error" | "cancelled";

export type QueueProgress = {
  current: number;
  total: number;
  file: string;
  bytesDone: number;
  bytesTotal: number;
};

export type QueueItem = {
  id: string;
  op: QueueOp;
  /** ファイル名など人間が読める短い説明 */
  label: string;
  /** 操作グループの説明（例: "コピー (3件)"） */
  groupLabel: string;
  status: QueueItemStatus;
  error?: string;
  addedAt: number;
  progress?: QueueProgress;
};

export type OperationQueueContextValue = {
  items: QueueItem[];
  paused: boolean;
  enqueue: (ops: Array<{ op: QueueOp; label: string }>, groupLabel: string) => void;
  cancelItem: (id: string) => void;
  retryItem: (id: string) => void;
  clearCompleted: () => void;
  setPaused: (paused: boolean) => void;
};

export const OperationQueueContext = createContext<OperationQueueContextValue>({
  items: [],
  paused: false,
  enqueue: () => {},
  cancelItem: () => {},
  retryItem: () => {},
  clearCompleted: () => {},
  setPaused: () => {},
});

export function useOperationQueue() {
  return useContext(OperationQueueContext);
}
