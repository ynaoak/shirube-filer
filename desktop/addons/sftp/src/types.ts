export type SftpConn = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  remotePath: string;
};

export type SftpEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
};
