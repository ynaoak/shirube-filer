import { useState } from "react";
import { ConflictInfo } from "../../types/fileListTypes";

export type DialogState = {
  propertiesPath: string | null;
  setPropertiesPath: (v: string | null) => void;
  archiveBrowserPath: string | null;
  setArchiveBrowserPath: (v: string | null) => void;
  showBatchRename: boolean;
  setShowBatchRename: (v: boolean) => void;
  diffPaths: { a: string; b: string } | null;
  setDiffPaths: (v: { a: string; b: string } | null) => void;
  compressTargets: string[] | null;
  setCompressTargets: (v: string[] | null) => void;
  conflictInfo: ConflictInfo | null;
  setConflictInfo: (v: ConflictInfo | null) => void;
  quickPreviewPath: string | null;
  setQuickPreviewPath: (v: string | null) => void;
  imageViewer: { path: string; siblings: string[] } | null;
  setImageViewer: (v: { path: string; siblings: string[] } | null) => void;
};

/** Centralises all modal/overlay open-state so FileList.tsx doesn't carry 8 nullable useState values. */
export function useDialogState(): DialogState {
  const [propertiesPath, setPropertiesPath] = useState<string | null>(null);
  const [archiveBrowserPath, setArchiveBrowserPath] = useState<string | null>(null);
  const [showBatchRename, setShowBatchRename] = useState(false);
  const [diffPaths, setDiffPaths] = useState<{ a: string; b: string } | null>(null);
  const [compressTargets, setCompressTargets] = useState<string[] | null>(null);
  const [conflictInfo, setConflictInfo] = useState<ConflictInfo | null>(null);
  const [quickPreviewPath, setQuickPreviewPath] = useState<string | null>(null);
  const [imageViewer, setImageViewer] = useState<{ path: string; siblings: string[] } | null>(null);

  return {
    propertiesPath, setPropertiesPath,
    archiveBrowserPath, setArchiveBrowserPath,
    showBatchRename, setShowBatchRename,
    diffPaths, setDiffPaths,
    compressTargets, setCompressTargets,
    conflictInfo, setConflictInfo,
    quickPreviewPath, setQuickPreviewPath,
    imageViewer, setImageViewer,
  };
}
