import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

/**
 * ドライブ構成の変化（USB メモリ・外付け HDD・スマートフォン等の抜き差し）を
 * Rust 側の常駐ウォッチャーから受け取り、コールバックを呼ぶ React フック。
 *
 * `onChange` は identity が安定している（useCallback 済み）ことを前提とする。
 */
export function useVolumesChanged(onChange: () => void): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("volumes-changed", () => onChange())
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onChange]);
}
