import { useState, useCallback, useEffect, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  KeybindingContext,
  DEFAULT_BINDINGS,
} from "../../store/keybindingStore";
import {
  KeyBinding,
  KeyDescriptor,
  KeybindingsConfig,
  ShortcutAction,
} from "../../types/keybinding";

export default function KeybindingProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState<KeyBinding[]>(DEFAULT_BINDINGS);

  const updateBinding = useCallback((action: ShortcutAction, keys: KeyDescriptor[]) => {
    setBindings((prev) =>
      prev.map((b) => (b.action === action ? { ...b, keys } : b))
    );
  }, []);

  const resetBindings = useCallback(() => {
    setBindings(DEFAULT_BINDINGS);
  }, []);

  const saveToFile = useCallback(async () => {
    const config: KeybindingsConfig = { version: 1, bindings };
    await invoke("save_keybindings", { config });
  }, [bindings]);

  const loadFromFile = useCallback(async () => {
    try {
      const config = await invoke<KeybindingsConfig>("load_keybindings");
      const merged = DEFAULT_BINDINGS.map((def) => {
        const saved = config.bindings.find((b) => b.action === def.action);
        return saved ? { ...def, keys: saved.keys } : def;
      });
      setBindings(merged);
    } catch {
      // ファイルが存在しない場合はデフォルトのまま
    }
  }, []);

  useEffect(() => {
    loadFromFile();
  }, [loadFromFile]);

  return (
    <KeybindingContext.Provider
      value={{ bindings, updateBinding, resetBindings, saveToFile, loadFromFile }}
    >
      {children}
    </KeybindingContext.Provider>
  );
}
