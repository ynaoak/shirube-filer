/**
 * パスに紐づくメタデータ（タグ・カラーラベル）を、移動/リネームに追従させるための
 * 純粋なパス書き換えロジック。
 *
 * タグもカラーラベルも「絶対パス → 値」のマップで保存しているため、ファイルを
 * 移動・リネームすると参照先が消えて設定が失われる。フォルダを移動した場合は
 * その配下すべてが動くので、子孫も一緒に付け替える必要がある。
 */

/** パス区切り（Windows のバックスラッシュも受け付ける）。 */
function isSep(ch: string | undefined): boolean {
  return ch === "/" || ch === "\\";
}

/**
 * `path` が `base` 自身、またはその配下かどうか。
 *
 * 前方一致だけで判定すると "/a/foo" に対して "/a/foobar" まで巻き込むため、
 * 直後が区切り文字であることを必ず確認する。
 */
export function isPathOrDescendant(path: string, base: string): boolean {
  if (path === base) return true;
  return path.startsWith(base) && isSep(path[base.length]);
}

/**
 * `path` が `from`（自身または配下）なら `to` 側へ読み替えた新しいパスを返す。
 * 対象外ならそのまま返す。
 */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (isPathOrDescendant(path, from)) return to + path.slice(from.length);
  return path;
}

/**
 * `path → 値` のマップを移動/リネームに追従させた新しいマップを返す。
 * 変化が無ければ同一参照を返す（不要な再レンダー・保存を避けるため）。
 *
 * 移動先に既存の値があった場合は「移動してきた側」を優先する
 * （上書き移動でファイル自体が置き換わっているため）。
 */
export function remapPathMap<T>(
  map: Record<string, T>,
  from: string,
  to: string
): Record<string, T> {
  if (from === to) return map;

  const moved: Array<[string, T]> = [];
  const kept: Array<[string, T]> = [];
  for (const [p, value] of Object.entries(map)) {
    const next = remapPath(p, from, to);
    if (next === p) kept.push([p, value]);
    else moved.push([next, value]);
  }
  if (moved.length === 0) return map;

  const result: Record<string, T> = {};
  for (const [p, value] of kept) result[p] = value;
  // 移動側を後に入れて、衝突時は移動してきた値で上書きする。
  for (const [p, value] of moved) result[p] = value;
  return result;
}

/**
 * 削除されたパス（と、フォルダなら配下すべて）の項目をマップから取り除く。
 * 変化が無ければ同一参照を返す。
 */
export function removePathsFromMap<T>(
  map: Record<string, T>,
  paths: string[]
): Record<string, T> {
  if (paths.length === 0) return map;

  const result: Record<string, T> = {};
  let removed = false;
  for (const [p, value] of Object.entries(map)) {
    if (paths.some((base) => isPathOrDescendant(p, base))) {
      removed = true;
      continue;
    }
    result[p] = value;
  }
  return removed ? result : map;
}
