import type { ViewMode } from "../../types/fileListTypes";

/**
 * 表示形式を「密度の梯子」として並べ、Ctrl + ホイール / Ctrl + "+" "-" で
 * 一段ずつ動かすための対応表。
 *
 * 並びは Explorer と同じく密度の高い順（詳細 → 一覧 → サムネイル小 → 大）。
 * 拡大方向（Ctrl + "+"、ホイール上）で右へ、縮小方向で左へ動く。
 */

export type GridItemSize = 64 | 96 | 128;

export type ViewStep = {
  mode: ViewMode;
  /** grid のときの一辺（px）。他のモードでは使わない。 */
  gridSize?: GridItemSize;
};

/** 密度の高い順。index がそのまま段数になる。 */
export const VIEW_STEPS: ViewStep[] = [
  { mode: "details" },
  { mode: "compact" },
  { mode: "grid", gridSize: 64 },
  { mode: "grid", gridSize: 128 },
];

/**
 * 現在の状態が梯子のどの段にいるかを返す。
 *
 * ツールバーのサイズ切替は 64/96/128 の3段階を回すため、梯子に無い 96 に
 * なっていることがある。その場合は近い側（小さいほう）の段として扱い、
 * そこから一段動かす。段に無い値へ勝手に留まり続けて「押しても変わらない」
 * ように見えるのを避けるため。
 */
export function viewStepIndex(mode: ViewMode, gridSize: GridItemSize): number {
  if (mode === "details") return 0;
  if (mode === "compact") return 1;
  return gridSize > 96 ? 3 : 2;
}

/**
 * 一段ぶん動かした先を返す。両端では動かない（端で反対側へ回り込むと、
 * 詳細表示から一気に最大サムネイルへ飛んで面食らうため）。
 */
export function stepView(mode: ViewMode, gridSize: GridItemSize, direction: 1 | -1): ViewStep {
  const current = viewStepIndex(mode, gridSize);
  const next = Math.min(VIEW_STEPS.length - 1, Math.max(0, current + direction));
  return VIEW_STEPS[next];
}
