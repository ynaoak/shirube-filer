/**
 * 組み込みの静的サーバー（Rust 側 static_server.rs）の呼び出し口。
 *
 * マニフェストが無いフォルダ（素の HTML/CSS/JS）でも、ルートとポートを決めれば
 * ブラウザで開けるようにするためのもの。待ち受けは 127.0.0.1 のみ。
 */

import { invoke } from "@tauri-apps/api/core";
import { samePath } from "./projectTasks";

export type StaticServerInfo = {
  port: number;
  /** 配信しているフォルダ */
  root: string;
  /** ブラウザで開く URL */
  url: string;
  /** ルート配下の変更でブラウザを再読み込みさせるか（ホットリロード） */
  liveReload: boolean;
};

/** 特権ポート（1023 以下）は使わせない。Rust 側と同じ下限。 */
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
export const DEFAULT_PORT = 8080;

/**
 * 入力欄の文字列をポート番号にする。使えない値なら null。
 *
 * 全角数字や空白混じりの入力も拾いたいので trim だけは行い、それ以外は
 * 「数字だけ」を要求する（"80 80" や "8080abc" を 80 と読んで別のポートを
 * 開いてしまわないように）。
 */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

/** 使い回すための「ルート＋ポート」の登録。 */
export type ServerPreset = {
  id: string;
  /** 表示名。空ならフォルダ名を出す */
  label: string;
  root: string;
  port: number;
  /** ルート配下の変更でブラウザを再読み込みさせるか（ホットリロード） */
  liveReload: boolean;
};

/** 登録できる件数。Rust 側の MAX_PRESETS と合わせる。 */
export const MAX_PRESETS = 32;

export function newPresetId(): string {
  return `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 登録を足す（同じフォルダ＋同じポートの登録があればそれを差し替える）。
 *
 * 同じ組み合わせを二重に持つと、起動・停止・削除がどの行に当たるのか分からなく
 * なるため、重複は作らない。フォルダが同じでポートが違う登録は別物として残す。
 */
export function upsertPreset(list: ServerPreset[], preset: ServerPreset): ServerPreset[] {
  const isSame = (p: ServerPreset) =>
    p.id === preset.id || (samePath(p.root, preset.root) && p.port === preset.port);
  const replaced = list.map((p) => (isSame(p) ? preset : p));
  if (replaced.some((p) => p.id === preset.id)) {
    // 差し替えが起きた場合、同じ組み合わせが複数残らないよう畳む
    return replaced.filter((p, i) => replaced.findIndex((q) => q.id === p.id) === i);
  }
  return [...list, preset];
}

export function removePreset(list: ServerPreset[], id: string): ServerPreset[] {
  return list.filter((p) => p.id !== id);
}

/** 登録の表示名（未設定ならフォルダ名）。 */
export function presetLabel(preset: ServerPreset): string {
  const trimmed = preset.label.trim();
  if (trimmed) return trimmed;
  const parts = preset.root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || preset.root;
}

export function loadServerPresets(): Promise<ServerPreset[]> {
  return invoke<ServerPreset[]>("load_server_presets");
}

export function saveServerPresets(presets: ServerPreset[]): Promise<void> {
  return invoke("save_server_presets", { presets });
}

export function startStaticServer(
  root: string,
  port: number,
  liveReload = true
): Promise<StaticServerInfo> {
  return invoke<StaticServerInfo>("start_static_server", { root, port, liveReload });
}

export function stopStaticServer(port: number): Promise<void> {
  return invoke("stop_static_server", { port });
}

export function listStaticServers(): Promise<StaticServerInfo[]> {
  return invoke<StaticServerInfo[]>("list_static_servers");
}
