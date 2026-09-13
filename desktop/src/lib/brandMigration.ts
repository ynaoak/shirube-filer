/**
 * ブランド統一（kakashi → shirube）に伴う localStorage 移行。
 *
 * 旧バージョンは localStorage のキーやテーマ ID に "kakashi-" を使っていた。
 * 名称変更で既存ユーザーのテーマ・言語・UI 設定・カスタムテーマ/プリセットが
 * 失われないよう、起動時に一度だけ次を行う:
 *   1) 旧キー（kakashi-*）を新キー（shirube-*）へ複製し、旧キーを除去する。
 *   2) 保存値に含まれるテーマ ID のプレフィックス "kakashi-" を "shirube-" へ書き換える。
 *
 * 冪等性: 新キーが既に存在する場合は上書きせず旧キーを除去するだけなので、
 * 複数回実行しても安全。新キーのみが存在する（移行済みの）状態では何もしない。
 *
 * 実行順序: テーマ/言語/設定を読む全モジュールより前に実行する必要がある
 * （main.tsx の最初の import である ./lib/brandMigration.boot 経由で実行）。
 */

/** 旧キー → 新キー の対応。 */
const KEY_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["kakashi-theme", "shirube-theme"],
  ["kakashi-ui-settings", "shirube-ui-settings"],
  ["kakashi-language", "shirube-language"],
  ["kakashi-custom-theme", "shirube-custom-theme"],
  ["kakashi-user-presets", "shirube-user-presets"],
];

/**
 * テーマ ID（"kakashi-dark" / "kakashi-light"）を値の中に含み得る、
 * 移行後（shirube-*）のキー。これらの保存値に対してのみプレフィックス置換を行う。
 * （言語キーの値は "ja"/"en" で "kakashi-" を含まないため対象外。）
 */
const THEME_VALUE_KEYS: readonly string[] = [
  "shirube-theme",
  "shirube-ui-settings",
  "shirube-custom-theme",
  "shirube-user-presets",
];

/**
 * 与えられた Storage に対してブランド移行を実施する。
 * localStorage が使えない環境（プライベートモード等）でも例外で起動を妨げない。
 */
export function migrateBrandStorage(storage: Storage): void {
  try {
    // 1) 旧キー → 新キー（新キーが未設定の場合のみ複製）。旧キーは常に除去。
    for (const [oldKey, newKey] of KEY_RENAMES) {
      const oldVal = storage.getItem(oldKey);
      if (oldVal === null) continue;
      if (storage.getItem(newKey) === null) storage.setItem(newKey, oldVal);
      storage.removeItem(oldKey);
    }

    // 2) 保存値中のテーマ ID プレフィックスを書き換える（JSON 文字列も含めて一括）。
    for (const key of THEME_VALUE_KEYS) {
      const val = storage.getItem(key);
      if (val !== null && val.includes("kakashi-")) {
        storage.setItem(key, val.replace(/kakashi-/g, "shirube-"));
      }
    }
  } catch {
    // 移行失敗は致命的ではない。既定値で起動を続ける。
  }
}
