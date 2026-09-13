import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { HAS_UPDATER } from "../buildConfig";

/** 公開サイトの version.json から得る更新情報（updater が使えないときのフォールバック）。 */
export type ManifestInfo = {
  current: string;
  latest: string;
  updateAvailable: boolean;
  url: string;
  notes: string;
};

export type UpdateCheckResult =
  /** 署名付きアップデートがあり、アプリ内でインストールできる */
  | { kind: "installable"; update: Update }
  /** updater が使えず、公開マニフェストで確認した結果（入手ページへ誘導） */
  | { kind: "manifest"; info: ManifestInfo }
  /** 最新版を使用中 */
  | { kind: "upToDate" };

/**
 * GitHub Releases の latest.json を tauri-plugin-updater で確認する。
 * updater が失敗したら（開発ビルド・エンドポイント未公開・ネットワーク等）従来の
 * version.json 確認にフォールバックする。両方失敗したら updater 側のエラーを投げる。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    return update ? { kind: "installable", update } : { kind: "upToDate" };
  } catch (updaterError) {
    try {
      const info = await invoke<ManifestInfo>("check_for_update");
      return info.updateAvailable ? { kind: "manifest", info } : { kind: "upToDate" };
    } catch {
      throw updaterError;
    }
  }
}

/**
 * 起動時のバックグラウンド確認。インストール可能な更新があればそのバージョンを返す。
 * 失敗・更新なし・ストア版では null（起動時に余計なエラー表示をしないため）。
 */
export async function checkForUpdateSilently(): Promise<string | null> {
  if (!HAS_UPDATER) return null;
  try {
    const update = await check();
    return update ? update.version : null;
  } catch {
    return null;
  }
}
