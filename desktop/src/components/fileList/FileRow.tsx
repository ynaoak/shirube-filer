import { memo } from "react";
import { FileEntry } from "../../types/fs";
import { PRESET_EXTS } from "../../hooks/useFileFilter";
import Icon from "../common/Icon";
import FileIcon from "./FileIcon";
import HighlightName from "./HighlightName";
import { formatSize, formatDate } from "./format";
import { OptionalCol } from "./constants";

// ─────────────────────────────────────────────────────────────────────
// FileRow: memoized row body for the virtualized file list.
// Renamed rows are rendered inline by the parent (single row at a time),
// so this component does NOT handle rename UI — keeping its props small
// and shallow-comparable for React.memo.
// ─────────────────────────────────────────────────────────────────────
export type RowLabels = {
  pinned: string;
  diffChanged: string;
  diffThisPaneOnly: string;
  colorLabel: string;
  typeFolder: string;
  typeImage: string;
  typeCode: string;
  typeText: string;
  typeArchive: string;
  typeFile: string;
};

export type FileRowProps = {
  entry: FileEntry;
  isSelected: boolean;
  isFocused: boolean;
  isDragOver: boolean;
  isCut: boolean;
  isPinned: boolean;
  colorLabel: string | undefined;
  diffStatus: string | null;
  dirSize: number | "loading" | undefined;
  showDirSizes: boolean;
  showColumnDividers: boolean;
  showRowDividers: boolean;
  visibleColsList: readonly OptionalCol[];
  gridTemplate: string;
  relDir: string | null;
  searchQuery: string;
  dateRelative: boolean;
  virtualRowSize: number;
  virtualRowStart: number;
  isDirDroppable: boolean;
  onClick: (entry: FileEntry, e: React.MouseEvent) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onDragStart: (e: React.DragEvent, entry: FileEntry) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, dirPath: string) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, dirPath: string) => void;
  labels: RowLabels;
};

const FileRow = memo(function FileRow(p: FileRowProps) {
  const {
    entry, isSelected, isFocused, isDragOver, isCut, isPinned,
    colorLabel, diffStatus, dirSize, showDirSizes,
    showColumnDividers, showRowDividers, visibleColsList, gridTemplate,
    relDir, searchQuery, dateRelative,
    virtualRowSize, virtualRowStart, isDirDroppable,
    onClick, onDoubleClick, onContextMenu,
    onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, labels,
  } = p;

  // Direct DOM hover paint — avoids any React state for hover.
  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelected && !isDragOver) {
      e.currentTarget.style.backgroundColor = "var(--kf-bg-secondary)";
    }
  };
  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelected && !isDragOver) {
      e.currentTarget.style.backgroundColor = "";
    }
  };

  const diffColor = diffStatus === "modified" ? "#f59e0b" : "#60a5fa";
  const diffTitle = diffStatus === "modified" ? labels.diffChanged : labels.diffThisPaneOnly;

  // 選択行のハイライト: 濃い塗り（--kf-sel-bg）＋ 左 2px のアクセント縦バー
  // （Explorer / Finder 風）。以前はアクセントの 22% の淡い塗りだったが、
  // それだと白いアイコンや文字が沈んで見分けにくかった。
  //
  // drop ターゲットは「塗りを変えるだけ」だと選択行と見分けがつかず、
  // ドラッグ中にどこへ落ちるのか分からなかった。塗りに加えてアクセント色の
  // 2px リングで囲み、選択とは別の表現にして一目で分かるようにする。
  const selBg = isDragOver
    ? "color-mix(in srgb, var(--kf-accent) 32%, transparent)"
    : isSelected
      ? "var(--kf-sel-bg)"
      : undefined;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: `${virtualRowSize}px`,
        transform: `translateY(${virtualRowStart}px)`,
      }}
    >
      <div
        role="option"
        aria-selected={isSelected}
        className="grid px-3 py-0.5 h-full items-center cursor-pointer select-none relative"
        style={{
          gridTemplateColumns: gridTemplate,
          backgroundColor: selBg,
          // 濃い塗りの上なので文字は白へ反転する。
          color: isSelected && !isDragOver ? "var(--kf-sel-fg)" : "var(--kf-text-primary)",
          // drop ターゲットのリングはフォーカス枠より優先（ドラッグ中は
          // 「どこに落ちるか」が最優先の情報のため）。
          outline: isDragOver
            ? "2px solid var(--kf-accent)"
            : isFocused && !isSelected
              ? "1px solid var(--kf-accent)"
              : undefined,
          outlineOffset: isDragOver ? "-2px" : "-1px",
          // 選択時の左アクセントバー（VSCode/Explorer 風）
          boxShadow: isSelected ? "inset 2px 0 0 0 var(--kf-accent)" : undefined,
          opacity: isCut ? 0.5 : entry.isHidden ? 0.6 : 1,
          borderBottom: showRowDividers ? "1px solid var(--kf-border-soft)" : undefined,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={(e) => onClick(entry, e)}
        onDoubleClick={() => onDoubleClick(entry)}
        onContextMenu={(e) => onContextMenu(e, entry)}
        draggable
        onDragStart={(e) => onDragStart(e, entry)}
        onDragEnd={onDragEnd}
        onDragOver={isDirDroppable ? (e) => onDragOver(e, entry.path) : undefined}
        onDragLeave={isDirDroppable ? onDragLeave : undefined}
        onDrop={isDirDroppable ? (e) => onDrop(e, entry.path) : undefined}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            paddingLeft: 4,
            paddingRight: 4,
            ...(showColumnDividers ? { borderRight: "1px solid var(--kf-border-soft)" } : {}),
          }}
        >
          <FileIcon entry={entry} isSelected={isSelected} />
        </div>
        {isPinned && (
          <Icon
            name="keep"
            size={11}
            title={labels.pinned}
            style={{
              color: "var(--kf-accent)",
              flexShrink: 0,
            }}
          />
        )}
        {diffStatus && diffStatus !== "identical" && (
          <span
            title={diffTitle}
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: diffColor,
              flexShrink: 0,
            }}
          />
        )}
        <span
          data-name-cell
          className="truncate text-xs flex items-center gap-1 leading-tight"
          style={{
            paddingLeft: 6,
            paddingRight: 6,
            ...(showColumnDividers ? { borderRight: "1px solid var(--kf-border-soft)" } : {}),
          }}
        >
          {colorLabel && (
            <span
              className="shrink-0 rounded-full"
              style={{ width: 7, height: 7, backgroundColor: colorLabel }}
              title={labels.colorLabel}
            />
          )}
          <span className="truncate flex flex-col leading-tight">
            <span>
              <HighlightName name={entry.name} query={searchQuery} />
            </span>
            {relDir && relDir !== "." && (
              <span
                className="text-[10px]"
                style={{ color: isSelected && !isDragOver ? "var(--kf-sel-fg-muted)" : "var(--kf-text-muted)" }}
              >
                {relDir}
              </span>
            )}
          </span>
        </span>
        {visibleColsList.map((col) => (
          <span
            key={col}
            className="text-right text-xs truncate"
            style={{
              paddingLeft: 6,
              paddingRight: 6,
              // 濃い選択塗りの上では、灰色のままだと沈む。
              color: isSelected && !isDragOver ? "var(--kf-sel-fg-muted)" : "var(--kf-text-muted)",
              ...(showColumnDividers ? { borderRight: "1px solid var(--kf-border-soft)" } : {}),
            }}
          >
            {col === "size" && (entry.isDir
              ? (showDirSizes
                  ? (dirSize === "loading"
                      ? <Icon name="progress_activity" size={11} className="animate-spin inline" />
                      : (typeof dirSize === "number"
                          ? <span style={{ color: isSelected && !isDragOver ? "var(--kf-sel-fg)" : "var(--kf-accent)" }}>{formatSize(dirSize)}</span>
                          : ""))
                  : "")
              : formatSize(entry.size))}
            {col === "modified" && formatDate(entry.modified, dateRelative)}
            {col === "ext" && (entry.extension ? `.${entry.extension}` : "")}
            {col === "type" && (entry.isDir ? labels.typeFolder : (() => {
              const ext = (entry.extension ?? "").toLowerCase();
              if (PRESET_EXTS.images.has(ext)) return labels.typeImage;
              if (PRESET_EXTS.code.has(ext)) return labels.typeCode;
              if (PRESET_EXTS.text.has(ext)) return labels.typeText;
              if (PRESET_EXTS.microsoft.has(ext)) return "Microsoft";
              if (PRESET_EXTS.archives.has(ext)) return labels.typeArchive;
              return labels.typeFile;
            })())}
          </span>
        ))}
      </div>
    </div>
  );
});

export default FileRow;
