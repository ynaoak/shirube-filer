import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TFunction } from "i18next";

type UseCreationArgs = {
  currentPath: string;
  navigate: (path: string) => Promise<void>;
  setSelected: (s: Set<string>) => void;
  setError: (msg: string) => void;
  t: TFunction;
};

/** Manages inline file/folder creation: state, template loading, auto-focus, and the commit handler. */
export function useCreation({ currentPath, navigate, setSelected, setError, t }: UseCreationArgs) {
  const [creatingType, setCreatingType] = useState<"file" | "dir" | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const [templates, setTemplates] = useState<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const creatingInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the name input when creation starts.
  useEffect(() => {
    if (creatingType) {
      setTimeout(() => creatingInputRef.current?.focus(), 30);
    }
  }, [creatingType]);

  // Load available file templates when creating a file.
  useEffect(() => {
    if (creatingType === "file") {
      invoke<string[]>("list_templates")
        .then(setTemplates)
        .catch(() => setTemplates([]));
      setSelectedTemplate("");
    } else {
      setTemplates([]);
      setSelectedTemplate("");
    }
  }, [creatingType]);

  const handleCreate = useCallback(async () => {
    if (!creatingType || !creatingName.trim()) {
      setCreatingType(null);
      return;
    }
    const sep = currentPath.includes("\\") ? "\\" : "/";
    const target = `${currentPath}${sep}${creatingName.trim()}`;
    try {
      if (creatingType === "dir") {
        await invoke("create_dir", { path: target });
      } else if (selectedTemplate) {
        await invoke("create_file_from_template", { target, templateName: selectedTemplate });
      } else {
        await invoke("create_file", { path: target });
      }
      setCreatingType(null);
      setCreatingName("");
      setSelectedTemplate("");
      await navigate(currentPath);
      setSelected(new Set([target]));
    } catch (e) {
      console.error("[create]", e);
      setError(creatingType === "dir" ? t("fileList.failedCreateFolder") : t("fileList.failedCreateFile"));
      setCreatingType(null);
    }
  }, [creatingType, creatingName, currentPath, navigate, selectedTemplate, setSelected, setError, t]);

  return {
    creatingType, setCreatingType,
    creatingName, setCreatingName,
    templates,
    selectedTemplate, setSelectedTemplate,
    creatingInputRef,
    handleCreate,
  };
}
