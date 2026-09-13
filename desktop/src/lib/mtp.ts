import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { showToast } from "./toast";
import i18n from "../i18n";
import type { FileEntry } from "../types/fs";

/**
 * MTP（スマートフォン/カメラ等ポータブルデバイス）関連のフロントヘルパー。
 *
 * これらの端末はドライブレターを持たず通常のファイルシステムに現れないため、
 * `mtp://<デバイス名>/<フォルダ>/...` という仮想パスで扱う。閲覧（read_dir）は
 * 通常のディレクトリと同様に流れるが、ファイルの実体アクセスはできないため、
 * 端末上のファイルは「ローカルへダウンロード」して利用する。
 */

export function isMtpPath(p: string): boolean {
  return p.startsWith("mtp://");
}

export type MtpDevice = { name: string };

/**
 * MTP が絡むファイル転送（ドラッグ&ドロップ / 貼り付け）の振り分け結果。
 *  - unsupported: 宛先が MTP（書き込み非対応）。何もしない。
 *  - downloads:   MTP → ローカルの取り出し（src は mtp:// の仮想パス）。
 *  - remaining:   通常のファイル移動/コピーとして処理を続けるパス。
 *
 * MTP の仮想パスをそのまま move_item/copy_item に渡すと「絶対パスを指定して
 * ください」で失敗するため、ドロップと貼り付けの入口でここに通して振り分ける。
 */
export type MtpTransferPlan = {
  unsupported: boolean;
  downloads: { src: string; dest: string }[];
  remaining: string[];
};

export function planMtpTransfer(srcPaths: string[], destDirRaw: string): MtpTransferPlan {
  if (isMtpPath(destDirRaw)) {
    return { unsupported: true, downloads: [], remaining: [] };
  }
  const mtpSrcs = srcPaths.filter(isMtpPath);
  if (mtpSrcs.length === 0) {
    return { unsupported: false, downloads: [], remaining: srcPaths };
  }
  // 宛先はローカルパスなので、区切り文字は宛先側に合わせる（Windows は "\"）。
  const sep = destDirRaw.includes("\\") ? "\\" : "/";
  const destDir =
    destDirRaw.length > 1 && destDirRaw.endsWith(sep) ? destDirRaw.slice(0, -1) : destDirRaw;
  return {
    unsupported: false,
    downloads: mtpSrcs.map((src) => ({
      src,
      // MTP 側の区切りは "/" 固定だが、末尾のファイル名だけ取れればよい。
      dest: `${destDir}${sep}${src.split(/[\\/]/).pop() ?? src}`,
    })),
    remaining: srcPaths.filter((p) => !isMtpPath(p)),
  };
}

/** 接続中の MTP デバイス一覧を取得する。 */
export async function listMtpDevices(): Promise<MtpDevice[]> {
  try {
    const r = await invoke<MtpDevice[]>("mtp_list_devices");
    // デモモード等でコマンド未実装のとき null/undefined が返り得る。
    // 呼び出し側が .map で落ちないよう必ず配列を返す。
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

/** MTP 上のファイルを保存先を選んでローカルへダウンロードする。 */
export async function downloadMtpEntry(entry: FileEntry): Promise<void> {
  try {
    const dest = await save({ defaultPath: entry.name });
    if (!dest) return;
    showToast(i18n.t("mtp.downloading", { name: entry.name }));
    await invoke("mtp_download", { path: entry.path, dest });
    showToast(i18n.t("mtp.downloadDone", { name: entry.name }));
  } catch (e) {
    showToast(i18n.t("mtp.downloadFailed", { error: String(e) }));
  }
}
