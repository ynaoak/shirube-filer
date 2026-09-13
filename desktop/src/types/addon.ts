export type AddonMeta = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  entryUi: string;
};

export type AddonInfo = {
  meta: AddonMeta;
  enabled: boolean;
  dir: string;
};

export type AddonComponent = React.ComponentType<AddonProps>;

export type AddonProps = {
  paneId?: string;
  currentPath?: string;
};
