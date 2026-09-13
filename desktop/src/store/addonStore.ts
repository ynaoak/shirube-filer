import { createContext, useContext } from "react";
import { AddonInfo, AddonComponent } from "../types/addon";

export type LoadedAddon = {
  info: AddonInfo;
  Component: AddonComponent;
};

export type AddonContextValue = {
  addons: AddonInfo[];
  loaded: Map<string, LoadedAddon>;
  reload: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
};

export const AddonContext = createContext<AddonContextValue | null>(null);

export function useAddons() {
  const ctx = useContext(AddonContext);
  if (!ctx) throw new Error("useAddons must be used within AddonProvider");
  return ctx;
}
