import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { FileEntry } from "../types/fs";

/**
 * OS シェル（Windows エクスプローラー）のアイコン取得。
 *
 * 2 系統ある:
 *  1. 同梱アイコン（パス単位）— exe / lnk / ico などファイル自身がアイコンを
 *     持つもの。個別に異なるため 1 ファイルずつ引く。
 *  2. 種別アイコン（拡張子単位）— それ以外。エクスプローラーと同じ絵柄を
 *     出すためのもので、同じ拡張子なら同じアイコンなので拡張子でキャッシュ
 *     でき、一覧が何千行でも IPC は拡張子の種類数で済む。
 *
 * 2 はアイコンセット設定が "system" のときだけ使う。取得できない・非対応
 * 環境（非 Windows）では null を返し、呼び出し側の内蔵アイコンにフォール
 * バックする。
 */

// 自身にアイコンを埋め込む代表的な拡張子。ここに該当するものは常にパス単位で引く。
const EMBEDDED_ICON_EXTS = new Set(["exe", "lnk", "ico", "scr", "msi", "cpl", "dll"]);

// キー（"path:<path>" / "ext:<ext>" / "dir"）→ dataURL(成功) / null(なし・失敗)。
// undefined は未解決。
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

// プラットフォーム判定は一度だけ解決してキャッシュする。Windows 以外では
// バックエンドが常に None を返すため、無駄な IPC を避けて即 null にする。
let platformPromise: Promise<string> | null = null;
function getPlatform(): Promise<string> {
  if (!platformPromise) {
    platformPromise = invoke<string>("get_platform").catch(() => "");
  }
  return platformPromise;
}

/**
 * entry に対して引くべきアイコンのキャッシュキーを決める。
 * useSystemIcons=false のときは同梱アイコン（exe 等）だけが対象。
 */
function iconKey(entry: FileEntry, useSystemIcons: boolean): string | null {
  if (entry.isSymlink) return null;
  if (entry.isDir) return useSystemIcons ? "dir" : null;
  const ext = entry.extension?.toLowerCase() ?? "";
  if (EMBEDDED_ICON_EXTS.has(ext)) return `path:${entry.path}`;
  if (!useSystemIcons) return null;
  return `ext:${ext}`;
}

async function resolve(key: string): Promise<string | null> {
  if (cache.has(key)) return cache.get(key) ?? null;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const platform = await getPlatform();
      if (platform !== "windows") {
        cache.set(key, null);
        return null;
      }
      let url: string | null = null;
      if (key.startsWith("path:")) {
        url = await invoke<string | null>("get_embedded_icon", { path: key.slice(5) });
      } else if (key === "dir") {
        url = await invoke<string | null>("get_file_type_icon", { extension: "", isDir: true });
      } else {
        url = await invoke<string | null>("get_file_type_icon", {
          extension: key.slice(4),
          isDir: false,
        });
      }
      cache.set(key, url ?? null);
      return url ?? null;
    } catch {
      cache.set(key, null);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * シェルアイコンの data URL を返す React フック。
 *  - 対象外 / 取得失敗 / 非 Windows: null（呼び出し側の内蔵アイコンを使う）
 *  - 取得成功: PNG の data URL
 *
 * @param useSystemIcons アイコンセット設定が "system" のとき true。false でも
 *   exe / lnk など「自身がアイコンを持つファイル」だけは従来どおり実アイコンを返す。
 */
export function useEmbeddedIcon(entry: FileEntry, useSystemIcons = false): string | null {
  const key = iconKey(entry, useSystemIcons);
  const [icon, setIcon] = useState<string | null>(() => (key ? cache.get(key) ?? null : null));

  useEffect(() => {
    if (!key) {
      setIcon(null);
      return;
    }
    const cached = cache.get(key);
    if (cached !== undefined) {
      setIcon(cached);
      return;
    }
    let cancelled = false;
    resolve(key).then((v) => {
      if (!cancelled) setIcon(v);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return key ? icon : null;
}

/**
 * 解決済みのアイコンをキャッシュから同期的に取り出す。
 *
 * ドラッグ開始時のカーソル追従画像は dragstart の中で同期的に組み立てる必要が
 * あり、非同期フックを待てない。行が既に表示されている＝取得済みなのが普通なので、
 * キャッシュにあればそれを使い、無ければ null（種別アイコンにフォールバック）。
 *
 * キーの決め方は useEmbeddedIcon と共通なので、一覧の行と同じ絵柄になる。
 */
export function getCachedEmbeddedIcon(entry: FileEntry, useSystemIcons = false): string | null {
  const key = iconKey(entry, useSystemIcons);
  if (!key) return null;
  return cache.get(key) ?? null;
}
