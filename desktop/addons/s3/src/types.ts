export type S3Profile = {
  id: string;
  name: string;
  accessKey: string;
  secretKey: string;
  region: string;
  endpoint: string; // 空文字なら AWS S3 を使用
};

export type S3Bucket = {
  name: string;
  created: number | null;
};

export type S3Entry = {
  key: string;
  name: string;
  isPrefix: boolean; // true = 仮想ディレクトリ
  size: number;
  lastModified: number | null;
  etag: string | null;
  storageClass: string | null;
};
