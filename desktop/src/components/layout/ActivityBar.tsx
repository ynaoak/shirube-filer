import { useTranslation } from "react-i18next";
import { useAddons } from "../../store/addonStore";
import { useOperationQueue } from "../../store/operationQueueStore";
import Icon from "../common/Icon";
import GitIcon from "../common/GitIcon";

export type LeftPanelTab = "tree" | "home" | "bookmark";

type Props = {
  // 左パネル
  showLeftPanel: boolean;
  leftPanelTab: LeftPanelTab;
  onSelectLeftTab: (tab: LeftPanelTab) => void;
  // 右パネル群
  showIndexPanel: boolean;
  onToggleIndexPanel: () => void;
  showTagPanel: boolean;
  onToggleTagPanel: () => void;
  showRulePanel: boolean;
  onToggleRulePanel: () => void;
  showSyncPanel: boolean;
  onToggleSyncPanel: () => void;
  showGrepPanel: boolean;
  onToggleGrepPanel: () => void;
  showQueuePanel: boolean;
  onToggleQueuePanel: () => void;
  showGitPanel: boolean;
  onToggleGitPanel: () => void;
  showTaskPanel: boolean;
  onToggleTaskPanel: () => void;
  showFolderCompare: boolean;
  onToggleFolderCompare: () => void;
  // アドオン
  openAddonId: string | null;
  onToggleAddon: (id: string) => void;
  loadedAddonIds: string[];
  // ユーティリティ
  onOpenSettings: () => void;
};

function QueueBadge() {
  const { items } = useOperationQueue();
  const active = items.filter((i) => i.status === "pending" || i.status === "running").length;
  const errors = items.filter((i) => i.status === "error").length;
  if (active === 0 && errors === 0) return null;
  // 実行中はアクセント色で件数、失敗が残っている場合はエラー色で件数を出し、
  // キューを開かなくても「失敗が残っている」ことに気付けるようにする
  const isError = active === 0 && errors > 0;
  return (
    <span
      className="absolute top-0.5 right-0.5 min-w-[12px] h-[12px] rounded-full flex items-center justify-center"
      style={{
        fontSize: 8,
        backgroundColor: isError ? "var(--kf-error, #ef4444)" : "var(--kf-accent)",
        color: "var(--kf-accent-fg, #fff)",
        lineHeight: 1,
        padding: "0 2px",
      }}
    >
      {isError ? errors : active}
    </span>
  );
}

function ActivityBtn({
  icon,
  iconNode,
  title,
  active,
  onClick,
  children,
}: {
  /** Material Symbols のリガチャ名（iconNode 指定時は不要） */
  icon?: string;
  /** 自作 SVG など任意のアイコン要素（icon より優先） */
  iconNode?: React.ReactNode;
  title: string;
  active?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="relative flex items-center justify-center rounded transition-colors"
      style={{
        width: 36,
        height: 36,
        // 非アクティブ: 通常色 / アクティブ: アクセント色（ネイティブの選択強調）
        color: active ? "var(--kf-text-primary)" : "var(--kf-text-muted)",
        // 背景はホバー時のみ。アクティブ強調は左の縦バーで表現する（VSCode 風）。
        backgroundColor: "transparent",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = "var(--kf-bg-tertiary)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
      }}
    >
      {/* アクティブインジケータ（左縦バー） */}
      {active && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: -4,
            top: 4,
            bottom: 4,
            width: 2,
            borderRadius: 2,
            backgroundColor: "var(--kf-accent)",
          }}
        />
      )}
      {iconNode ?? <Icon name={icon ?? ""} size={18} />}
      {children}
    </button>
  );
}

function Divider() {
  return (
    <div
      className="mx-auto my-1"
      style={{ width: 20, height: 1, backgroundColor: "var(--kf-border)" }}
    />
  );
}

export default function ActivityBar({
  showLeftPanel,
  leftPanelTab,
  onSelectLeftTab,
  showIndexPanel,
  onToggleIndexPanel,
  showTagPanel,
  onToggleTagPanel,
  showRulePanel,
  onToggleRulePanel,
  showSyncPanel,
  onToggleSyncPanel,
  showGrepPanel,
  onToggleGrepPanel,
  showQueuePanel,
  onToggleQueuePanel,
  showGitPanel,
  onToggleGitPanel,
  showTaskPanel,
  onToggleTaskPanel,
  showFolderCompare,
  onToggleFolderCompare,
  openAddonId,
  onToggleAddon,
  loadedAddonIds,
  onOpenSettings,
}: Props) {
  const { t } = useTranslation();
  const { loaded } = useAddons();

  const isLeftTab = (tab: LeftPanelTab) => showLeftPanel && leftPanelTab === tab;

  return (
    <div
      className="flex-shrink-0 flex flex-col items-center py-1 border-r"
      style={{
        width: 44,
        backgroundColor: "var(--kf-bg-secondary)",
        borderColor: "var(--kf-border)",
      }}
    >
      {/* 左パネルタブ */}
      <ActivityBtn
        icon="account_tree"
        title={t("toolbar.fileTree")}
        active={isLeftTab("tree")}
        onClick={() => onSelectLeftTab("tree")}
      />
      <ActivityBtn
        icon="storage"
        title={t("toolbar.drive")}
        active={isLeftTab("home")}
        onClick={() => onSelectLeftTab("home")}
      />
      <ActivityBtn
        icon="star"
        title={t("toolbar.bookmark")}
        active={isLeftTab("bookmark")}
        onClick={() => onSelectLeftTab("bookmark")}
      />

      <Divider />

      {/* 機能パネル */}
      <ActivityBtn
        icon="travel_explore"
        title={t("activityBar.indexSearch")}
        active={showIndexPanel}
        onClick={onToggleIndexPanel}
      />
      <ActivityBtn
        icon="manage_search"
        title={t("toolbar.fileSearch")}
        active={showGrepPanel}
        onClick={onToggleGrepPanel}
      />

      <Divider />

      <ActivityBtn
        icon="sell"
        title={t("activityBar.tags")}
        active={showTagPanel}
        onClick={onToggleTagPanel}
      />
      <ActivityBtn
        icon="bolt"
        title={t("activityBar.rules")}
        active={showRulePanel}
        onClick={onToggleRulePanel}
      />
      <ActivityBtn
        icon="cloud"
        title={t("activityBar.cloudSync")}
        active={showSyncPanel}
        onClick={onToggleSyncPanel}
      />

      <Divider />

      <ActivityBtn
        iconNode={<GitIcon size={18} />}
        title="Git"
        active={showGitPanel}
        onClick={onToggleGitPanel}
      />
      <ActivityBtn
        icon="play_circle"
        title={t("activityBar.tasks")}
        active={showTaskPanel}
        onClick={onToggleTaskPanel}
      />
      <ActivityBtn
        icon="difference"
        title={t("toolbar.folderCompare")}
        active={showFolderCompare}
        onClick={onToggleFolderCompare}
      />
      <ActivityBtn
        icon="queue"
        title={t("toolbar.queue")}
        active={showQueuePanel}
        onClick={onToggleQueuePanel}
      >
        <QueueBadge />
      </ActivityBtn>

      {/* アドオン */}
      {loadedAddonIds.map((id) => {
        const info = loaded.get(id)?.info;
        if (!info) return null;
        return (
          <ActivityBtn
            key={id}
            icon="extension"
            title={info.meta.description}
            active={openAddonId === id}
            onClick={() => onToggleAddon(id)}
          />
        );
      })}

      {/* スペーサー */}
      <div className="flex-1" />

      {/* ユーティリティ */}
      <ActivityBtn icon="settings" title={t("toolbar.settings")} onClick={onOpenSettings} />
    </div>
  );
}
