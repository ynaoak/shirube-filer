export type OneDriveProfile = {
  id: string;
  name: string;
  refreshToken: string;
};

export type OneDriveTokens = {
  accessToken: string;
  refreshToken: string | null;
};

export type OneDriveEntry = {
  id: string;
  name: string;
  isDir: boolean;
  size: number;
  modified: string | null;
  mimeType: string | null;
};

export type FolderItem = {
  id: string;   // "root" またはアイテム ID
  name: string;
};
