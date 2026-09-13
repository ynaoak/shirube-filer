export type GDriveProfile = {
  id: string;
  name: string;
  refreshToken: string; // localStorage に保存
};

export type GDriveTokens = {
  accessToken: string;
  refreshToken: string | null;
};

export type GDriveEntry = {
  id: string;
  name: string;
  isDir: boolean;
  isGoogleDoc: boolean; // Google Workspace ファイル（PDF エクスポートのみ）
  size: number;
  modified: string | null;
  mimeType: string | null;
};

export type FolderItem = {
  id: string;
  name: string;
};
