export type FileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  isHidden: boolean;
  size: number;
  modified: number | null;
  extension: string | null;
};

export type ReadDirResult = {
  path: string;
  entries: FileEntry[];
};

export type FileMetadata = {
  path: string;
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  isHidden: boolean;
  readonly: boolean;
  size: number;
  created: number | null;
  modified: number | null;
  accessed: number | null;
  symlinkTarget: string | null;
  permissions: string | null;
};
