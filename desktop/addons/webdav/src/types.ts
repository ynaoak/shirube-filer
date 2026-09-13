export type WebDavConn = {
  id: string;
  name: string;
  baseUrl: string;   // e.g. https://cloud.example.com/remote.php/dav/files/user
  username: string;
  password: string;
};

export type WebDavEntry = {
  name: string;
  href: string;   // URL path component, e.g. /remote.php/dav/files/user/Documents/
  isDir: boolean;
  size: number;
  modified: number | null;
};
