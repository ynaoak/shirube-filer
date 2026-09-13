import { useState, useEffect, useCallback, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AddonInfo, AddonComponent } from "../../types/addon";
import { AddonContext, LoadedAddon } from "../../store/addonStore";

type Props = { children: ReactNode };

export default function AddonProvider({ children }: Props) {
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  const [loaded, setLoaded] = useState<Map<string, LoadedAddon>>(new Map());

  const loadAddonComponent = async (
    info: AddonInfo
  ): Promise<AddonComponent | null> => {
    try {
      const entryPath = await invoke<string>("get_addon_entry_path", {
        id: info.meta.id,
      });
      // Tauri の asset プロトコル経由でローカルファイルを動的 import
      const assetUrl = convertFileSrc(entryPath);
      const mod = await import(/* @vite-ignore */ assetUrl);
      return (mod.default ?? mod) as AddonComponent;
    } catch (e) {
      console.warn(`アドオン '${info.meta.id}' の読み込みに失敗:`, e);
      return null;
    }
  };

  const reload = useCallback(async () => {
    const list = await invoke<AddonInfo[]>("list_addons");
    setAddons(list);

    const newLoaded = new Map<string, LoadedAddon>();
    for (const info of list) {
      if (!info.enabled) continue;
      const Component = await loadAddonComponent(info);
      if (Component) {
        newLoaded.set(info.meta.id, { info, Component });
      }
    }
    setLoaded(newLoaded);
  }, []);

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    await invoke("set_addon_enabled", { id, enabled });
    await reload();
  }, [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <AddonContext.Provider value={{ addons, loaded, reload, setEnabled }}>
      {children}
    </AddonContext.Provider>
  );
}
