import { migrateBrandStorage } from "./brandMigration";

/**
 * 副作用専用モジュール。テーマ/言語/設定を localStorage から読む他モジュールより
 * 「前」に移行を完了させるため、main.tsx の最初の import として読み込む。
 * （ES モジュールは import 順に評価されるため、この import を先頭に置くことで
 *  i18n / stores / ThemeProvider の読み取りより前に移行が走る。）
 */
if (typeof localStorage !== "undefined") {
  migrateBrandStorage(localStorage);
}
