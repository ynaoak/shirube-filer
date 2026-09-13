export type GcsProfile = {
  id: string;
  name: string;
  projectId: string;
  refreshToken: string; // OS の資格情報ストア（キーリング）に保存（Google アカウントで随時失効可能）
};

export type GcsBucket = {
  name: string;
  location: string | null;
  created: string | null;
};

export type GcsEntry = {
  key: string;
  name: string;
  isPrefix: boolean;
  size: number;
  updated: string | null;
  contentType: string | null;
  storageClass: string | null;
};

export type GcsTokens = {
  accessToken: string;
  refreshToken: string | null;
};
