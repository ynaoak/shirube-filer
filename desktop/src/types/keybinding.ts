export type ShortcutAction =
  | "file.selectUp"
  | "file.selectDown"
  | "file.open"
  | "file.navigateUp"
  | "file.rename"
  | "file.delete"
  | "file.refresh"
  | "file.properties"
  | "file.copyPath"
  | "file.revealInExplorer"
  | "file.addBookmark"
  | "clipboard.copy"
  | "clipboard.cut"
  | "clipboard.paste"
  | "search.open"
  | "tab.new"
  | "tab.close";

export type KeyDescriptor = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type KeyBinding = {
  action: ShortcutAction;
  keys: KeyDescriptor[];
  description: string;
};

export type KeybindingsConfig = {
  version: 1;
  bindings: KeyBinding[];
};
