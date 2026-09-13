import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../common/Icon";
import { formatModCombo } from "../../store/keybindingStore";
import { listMtpDevices, type MtpDevice } from "../../lib/mtp";
import { useVolumesChanged } from "../../lib/volumeWatch";

export type HomeVolume = {
  path: string;
  label: string;
  kind: "fixed" | "removable" | "unknown";
};

type Props = {
  volumes: HomeVolume[];
  bookmarks: { name: string; path: string }[];
  recent: string[];
  onNavigate: (path: string) => void;
  onOpenTrash: () => void;
};

/** ドライブ・クイックアクセス共通のタイルボタン。 */
function Tile({
  icon,
  iconColor,
  title,
  subtitle,
  onClick,
}: {
  icon: string;
  iconColor?: string;
  title: string;
  subtitle?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center text-left"
      title={subtitle ?? title}
      style={{
        gap: 10,
        padding: "10px 12px",
        borderRadius: 8,
        minWidth: 140,
        // 狭いペインでサブタイトル（パス）の長さにタイルが引きずられて
        // はみ出さないよう、コンテナ幅を上限にする（truncate は内側で効く）
        maxWidth: "100%",
        border: "1px solid var(--kf-border)",
        backgroundColor: "var(--kf-bg-secondary)",
        transition: "background-color 140ms ease, border-color 140ms ease",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.borderColor = "var(--kf-accent)";
        el.style.backgroundColor = "var(--kf-bg-tertiary)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.borderColor = "var(--kf-border)";
        el.style.backgroundColor = "var(--kf-bg-secondary)";
      }}
    >
      <Icon name={icon} size={16} style={{ color: iconColor ?? "var(--kf-accent)", flexShrink: 0 }} />
      <div className="flex flex-col min-w-0">
        <span className="text-[13px] font-semibold truncate" style={{ color: "var(--kf-text-primary)" }}>{title}</span>
        {subtitle && (
          <span className="text-[11px] truncate" style={{ color: "var(--kf-text-muted)" }}>{subtitle}</span>
        )}
      </div>
    </button>
  );
}

type QuickItem = { name: string; path: string; icon: string };

// パスが空のとき（ホーム）に表示する: クイックアクセス / ドライブ / ブックマーク / 最近のフォルダ。
export default function FileListHomeView({ volumes, bookmarks, recent, onNavigate, onOpenTrash }: Props) {
  const { t } = useTranslation();

  // MTP デバイス（iPhone / Android 等）。ドライブレターを持たないため
  // volumes には現れない。左のドライブパネルと同様にここでも列挙し、
  // ペインのドライブ一覧からも mtp:// へ入れるようにする。
  // 抜き差し（volumes-changed）で自動更新する。
  const [mtpDevices, setMtpDevices] = useState<MtpDevice[]>([]);
  const reloadMtp = useCallback(() => {
    listMtpDevices().then(setMtpDevices).catch(() => setMtpDevices([]));
  }, []);
  useEffect(() => { reloadMtp(); }, [reloadMtp]);
  useVolumesChanged(reloadMtp);

  // クイックアクセス: ホーム直下の標準フォルダ（存在するものだけ表示）。
  // 初回起動でブックマークも履歴も無い状態でも、ワンクリックで主要な場所へ行ける。
  const [quick, setQuick] = useState<QuickItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const home = await invoke<string>("get_home_dir").catch(() => null);
      if (!home || cancelled) return;
      const sep = home.includes("\\") ? "\\" : "/";
      const candidates: { sub: string; icon: string; label: string }[] = [
        { sub: "", icon: "home", label: t("home.quickHome") },
        { sub: "Desktop", icon: "desktop_windows", label: t("home.folderDesktop") },
        { sub: "Documents", icon: "description", label: t("home.folderDocuments") },
        { sub: "Downloads", icon: "download", label: t("home.folderDownloads") },
        { sub: "Pictures", icon: "image", label: t("home.folderPictures") },
        { sub: "Music", icon: "music_note", label: t("home.folderMusic") },
        { sub: "Videos", icon: "movie", label: t("home.folderVideos") },
      ];
      const found: QuickItem[] = [];
      for (const c of candidates) {
        const path = c.sub ? `${home}${sep}${c.sub}` : home;
        const exists = c.sub === "" ? true : await invoke<boolean>("path_exists", { path }).catch(() => false);
        if (exists) found.push({ name: c.label, path, icon: c.icon });
      }
      if (!cancelled) setQuick(found);
    })();
    return () => { cancelled = true; };
    // t は言語切替時に再評価したいので依存に含める
  }, [t]);

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
      {/* クイックアクセス（標準フォルダ） */}
      {quick.length > 0 && (
        <section>
          <div className="mb-2 text-xs font-semibold" style={{ color: "var(--kf-text-muted)" }}>
            {t("home.quickAccess")}
          </div>
          <div className="flex flex-wrap gap-2">
            {quick.map((q) => (
              <Tile key={q.path} icon={q.icon} title={q.name} subtitle={q.path} onClick={() => onNavigate(q.path)} />
            ))}
          </div>
        </section>
      )}

      {/* ドライブ */}
      <section>
        <div className="mb-2 text-xs font-semibold" style={{ color: "var(--kf-text-muted)" }}>
          {t("home.drives")}
        </div>
        <div className="flex flex-wrap gap-2">
          {volumes.map((vol) => {
            // ルートボリューム（"/"）は replace で空文字になるためラベル→整形パス→生パスの順でフォールバックする
            const cleanedPath = vol.path.replace(/[\\/]$/, "");
            const title = vol.label || cleanedPath || vol.path;
            return (
              <Tile
                key={vol.path}
                icon={vol.kind === "removable" ? "usb" : "storage"}
                title={title}
                subtitle={vol.label ? vol.path : undefined}
                onClick={() => onNavigate(vol.path)}
              />
            );
          })}
          {/* MTP デバイス（スマホ等）。名前を仮想パス mtp://<name> に変換して開く */}
          {mtpDevices.map((dev) => (
            <Tile
              key={`mtp:${dev.name}`}
              icon="smartphone"
              title={dev.name}
              subtitle={t("drivePanel.mtp")}
              onClick={() => onNavigate(`mtp://${dev.name}`)}
            />
          ))}
          <Tile icon="delete" iconColor="var(--kf-text-muted)" title={t("toolbar.trash")} onClick={onOpenTrash} />
        </div>
      </section>

      {/* ブックマーク */}
      {bookmarks.length > 0 && (
        <section>
          <div className="mb-2 text-xs font-semibold" style={{ color: "var(--kf-text-muted)" }}>
            {t("home.bookmarks")}
          </div>
          <div className="flex flex-col gap-0.5">
            {bookmarks.map((bm) => (
              <button
                key={bm.path}
                onClick={() => onNavigate(bm.path)}
                className="flex items-center gap-2 px-2 py-1 rounded text-left text-xs"
                style={{ color: "var(--kf-text-primary)", transition: "background-color 140ms ease" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ""; }}
                title={bm.path}
              >
                <Icon name="bookmarks" size={13} style={{ color: "var(--kf-accent)", flexShrink: 0 }} />
                <span className="font-medium">{bm.name}</span>
                <span className="truncate" style={{ color: "var(--kf-text-muted)", maxWidth: 320 }}>{bm.path}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 最近のフォルダ */}
      {recent.length > 0 && (
        <section>
          <div className="mb-2 text-xs font-semibold" style={{ color: "var(--kf-text-muted)" }}>
            {t("home.recent")}
          </div>
          <div className="flex flex-col gap-0.5">
            {recent.map((p) => (
              <button
                key={p}
                onClick={() => onNavigate(p)}
                className="flex items-center gap-2 px-2 py-1 rounded text-left text-xs"
                style={{ color: "var(--kf-text-primary)", transition: "background-color 140ms ease" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--kf-bg-secondary)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ""; }}
                title={p}
              >
                <Icon name="history" size={13} style={{ color: "var(--kf-text-muted)", flexShrink: 0 }} />
                <span className="truncate">{p}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ヒント: キーボード操作の発見性（ホームの余白を活用した控えめな案内） */}
      <div className="mt-auto flex items-center gap-2 flex-wrap" style={{ color: "var(--kf-text-muted)", fontSize: 11 }}>
        <Icon name="lightbulb" size={12} style={{ flexShrink: 0 }} />
        <span>
          {t("home.tipPalette")} <Kbd>{formatModCombo("P", { shift: true })}</Kbd> ／ {t("home.tipSearch")} <Kbd>{formatModCombo("F")}</Kbd>
        </span>
      </div>
    </div>
  );
}

/** ヒント表示用のキーキャップ風スタイル。 */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="px-1 py-px rounded"
      style={{
        border: "1px solid var(--kf-border)",
        backgroundColor: "var(--kf-bg-secondary)",
        fontFamily: "inherit",
        fontSize: 10,
      }}
    >
      {children}
    </kbd>
  );
}
