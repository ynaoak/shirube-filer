import { useCallback } from "react";
import { useTags } from "../store/tagStore";
import { useColorLabels } from "../store/colorLabelStore";

/**
 * ファイルの移動・リネームに、パス紐づけのメタデータを追従させる。
 *
 * タグもカラーラベルも「絶対パス → 値」で保存しているので、パスが変わると
 * 設定が迷子になる。移動/リネームを実行した箇所からこれを呼ぶ。
 * フォルダを動かした場合は配下も一緒に付け替わる。
 *
 * ```ts
 * const followPathChange = useFollowPathChange();
 * await invoke("rename_item", { src, newName });
 * followPathChange(src, newPath);
 * ```
 */
export function useFollowPathChange() {
  const { movePath: moveTags } = useTags();
  const { movePath: moveLabels } = useColorLabels();

  return useCallback(
    (from: string, to: string) => {
      if (!from || !to || from === to) return;
      moveTags(from, to);
      moveLabels(from, to);
    },
    [moveTags, moveLabels]
  );
}

/**
 * 削除されたファイルのタグ・カラーラベルを捨てる。
 * フォルダを削除した場合は配下の分もまとめて消える。
 *
 * ゴミ箱行きか完全削除かは区別しない。ゴミ箱から戻したときにタグが復活
 * しなくなるが、消したはずのファイルの設定がいつまでも残って
 * ラベル一覧を汚す方が実害が大きいため。
 */
export function useForgetPathMetadata() {
  const { removePaths: forgetTags } = useTags();
  const { removePaths: forgetLabels } = useColorLabels();

  return useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      forgetTags(paths);
      forgetLabels(paths);
    },
    [forgetTags, forgetLabels]
  );
}
