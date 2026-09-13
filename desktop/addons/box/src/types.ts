export type BoxProfile = {
  id: string;
  name: string;
  refreshToken: string; // OS の資格情報ストア（キーリング）に保存
};

export type BoxTokens = {
  accessToken: string;
  refreshToken: string | null;
};

export type BoxEntry = {
  id: string;
  name: string;
  isDir: boolean;
  size: number;
  modifiedAt: string | null;
};

export type FolderItem = {
  id: string;
  name: string;
};
