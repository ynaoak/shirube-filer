const variant = (import.meta.env.VITE_BUILD_VARIANT ?? "") as string;

export const BUILD_VARIANT = variant as "msstore" | "mas" | "";

/** PTY ターミナルペインが使用可能か（MAS / Microsoft Store では無効） */
export const HAS_TERMINAL = variant !== "msstore" && variant !== "mas";

/** シェルコマンド実行が使用可能か（Microsoft Store では無効） */
export const HAS_SHELL_COMMANDS = variant !== "msstore";

/**
 * 組み込みの静的サーバーが使用可能か（MAS / Microsoft Store では無効）。
 * MAS の App Sandbox には com.apple.security.network.server が無く待ち受けできない。
 */
export const HAS_BUILTIN_SERVER = variant !== "msstore" && variant !== "mas";

/**
 * アプリ内アップデート確認を表示するか。
 * ストア版（MAS / Microsoft Store）はストアが更新を配信するため無効。
 */
export const HAS_UPDATER = variant !== "msstore" && variant !== "mas";
