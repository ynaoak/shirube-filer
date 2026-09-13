import Icon from "../common/Icon";
import type { SyncProvider } from "../../store/syncStore";

// サービスをひと目で識別する色付きチップ。ブランドロゴの同梱は商標・配布の
// 都合を避け、ブランドカラー＋略号で表現する。
const BADGE: Record<SyncProvider, { code: string; bg: string; fg?: string } | { icon: string }> = {
  s3:       { code: "S3", bg: "#569A31" },
  gcs:      { code: "GC", bg: "#4285F4" },
  gdrive:   { code: "Dr", bg: "#34A853" },
  dropbox:  { code: "Db", bg: "#0061FF" },
  onedrive: { code: "OD", bg: "#0F6CBD" },
  azblob:   { code: "Az", bg: "#0078D4" },
  box:      { code: "Bx", bg: "#0061D5" },
  sftp:     { icon: "terminal" },
  webdav:   { icon: "dns" },
};

export default function ProviderBadge({ provider, size = 18 }: { provider: SyncProvider; size?: number }) {
  const b = BADGE[provider];
  if ("icon" in b) {
    return (
      <span
        className="inline-flex items-center justify-center rounded flex-shrink-0"
        style={{ width: size, height: size, backgroundColor: "var(--kf-bg-tertiary)", color: "var(--kf-text-secondary)" }}
      >
        <Icon name={b.icon} size={Math.round(size * 0.7)} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded flex-shrink-0 font-bold select-none"
      style={{ width: size, height: size, backgroundColor: b.bg, color: b.fg ?? "#fff", fontSize: Math.round(size * 0.5) }}
    >
      {b.code}
    </span>
  );
}
