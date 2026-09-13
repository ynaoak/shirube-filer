export type DropboxProfile = {
  id: string;
  name: string;
  refreshToken: string;
};

export type DropboxTokens = {
  accessToken: string;
  refreshToken: string | null;
};

export type DropboxEntry = {
  id: string;
  name: string;
  isDir: boolean;
  size: number;
  modified: string | null;
  /** ファイル操作に使用するパス（例: "/Documents/file.txt"）*/
  pathDisplay: string;
};

export type FolderItem = {
  /** ルートは ""、サブフォルダは "/folder" 形式 */
  path: string;
  name: string;
};
