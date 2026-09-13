import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../common/Icon";

type DiskEntry = {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
};

type Rect = { x: number; y: number; w: number; h: number };
type TreemapNode = DiskEntry & { rect: Rect };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Squarified treemap algorithm
function squarify(
  items: DiskEntry[],
  rect: Rect,
  total: number
): TreemapNode[] {
  if (items.length === 0 || total === 0) return [];
  const nodes: TreemapNode[] = [];
  let remaining = [...items];
  let { x, y, w, h } = rect;

  while (remaining.length > 0) {
    const shortSide = Math.min(w, h);
    const horizontal = w >= h;

    // Find the best row
    let rowItems: DiskEntry[] = [];
    let rowTotal = 0;
    let bestRatio = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const next = remaining.slice(0, i + 1);
      const nextTotal = next.reduce((s, e) => s + e.size, 0);
      const rowW = shortSide;
      const rowH = total > 0 ? (nextTotal / total) * (horizontal ? h : w) : 0;
      const ratio = next.reduce((worst, e) => {
        const cellW = rowH > 0 ? ((e.size / nextTotal) * rowW * rowW) / rowH : 0;
        const cellH = rowH;
        const r = cellW > cellH ? cellW / cellH : cellH / cellW;
        return Math.max(worst, r);
      }, 0);

      if (ratio <= bestRatio || rowItems.length === 0) {
        bestRatio = ratio;
        rowItems = next;
        rowTotal = nextTotal;
      } else {
        break;
      }
    }

    const rowFrac = rowTotal / total;
    const rowLength = horizontal ? h * rowFrac : w * rowFrac;

    let offset = horizontal ? y : x;
    for (const item of rowItems) {
      const cellLength = (horizontal ? h : w) * rowFrac === 0
        ? 0
        : (item.size / rowTotal) * (horizontal ? w : h);

      if (horizontal) {
        nodes.push({
          ...item,
          rect: { x: x, y: offset, w: rowLength, h: cellLength },
        });
        offset += cellLength;
      } else {
        nodes.push({
          ...item,
          rect: { x: offset, y: y, w: cellLength, h: rowLength },
        });
        offset += cellLength;
      }
    }

    remaining = remaining.slice(rowItems.length);
    total -= rowTotal;

    if (horizontal) {
      x += rowLength;
      w -= rowLength;
    } else {
      y += rowLength;
      h -= rowLength;
    }
  }

  return nodes;
}

// Simple color palette for directories/files
const COLORS = [
  "#3b82f6", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b",
  "#ef4444", "#ec4899", "#6366f1", "#14b8a6", "#f97316",
];

type Props = {
  rootPath: string;
  onNavigate: (path: string) => void;
  onClose: () => void;
};

export default function DiskTreemap({ rootPath, onNavigate, onClose }: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DiskEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 600, h: 400 });

  // ディスク使用量の集計は配下を丸ごと走査する。閉じた・別フォルダへ移った時点で
  // 止めないと、裏で掘り続けて次の読み込みを待たせてしまう。
  const scanTokenRef = useRef(`treemap:${rootPath}`);
  const cancelScan = useCallback(() => {
    invoke("cancel_scan", { token: scanTokenRef.current }).catch(() => {});
  }, []);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const items = await invoke<DiskEntry[]>("get_disk_usage", { path, scanToken: scanTokenRef.current });
      setEntries(items.filter((e) => e.size > 0));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(currentPath);
    return () => { cancelScan(); };
  }, [currentPath, load, cancelScan]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setDims({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const total = entries.reduce((s, e) => s + e.size, 0);
  const nodes = squarify(entries, { x: 0, y: 0, w: dims.w, h: dims.h }, total);

  const pathParts = currentPath.split(/[\\/]/).filter(Boolean);

  const navigateTo = (path: string) => {
    setCurrentPath(path);
  };

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col text-xs"
      style={{ backgroundColor: "var(--kf-bg-primary)", color: "var(--kf-text-primary)" }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 shrink-0 border-b"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="donut_large" size={14} style={{ color: "var(--kf-accent)" }} />
        <span className="font-semibold">{t("diskTreemap.title")}</span>

        {/* Breadcrumb */}
        <div className="flex items-center gap-0.5 flex-1 overflow-hidden">
          <button
            onClick={() => navigateTo(rootPath)}
            className="opacity-60 hover:opacity-100 shrink-0"
            title={rootPath}
          >
            <Icon name="home" size={13} />
          </button>
          {pathParts.slice(rootPath.split(/[\\/]/).filter(Boolean).length).map((part, i, arr) => {
            const partPath = currentPath
              .split(/[\\/]/)
              .slice(0, rootPath.split(/[\\/]/).filter(Boolean).length + i + 1)
              .join("/");
            return (
              <span key={i} className="flex items-center gap-0.5 shrink-0">
                <Icon name="chevron_right" size={12} style={{ color: "var(--kf-text-muted)" }} />
                <button
                  onClick={() => navigateTo(partPath)}
                  className={`hover:opacity-100 ${i === arr.length - 1 ? "opacity-100" : "opacity-60"}`}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </div>

        <span style={{ color: "var(--kf-text-muted)" }}>{formatSize(total)}</span>

        <button
          onClick={() => {
            onNavigate(currentPath);
            onClose();
          }}
          className="flex items-center gap-1 px-2 py-0.5 rounded opacity-70 hover:opacity-100"
          style={{ border: "1px solid var(--kf-border)" }}
          title={t("diskTreemap.navigateTo")}
        >
          <Icon name="folder_open" size={12} />
          {t("diskTreemap.navigate")}
        </button>

        <button
          onClick={onClose}
          className="flex items-center opacity-60 hover:opacity-100"
          title={t("diskTreemap.close")}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* Treemap area */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full opacity-50 gap-2">
            <Icon name="hourglass_empty" size={20} />
            <span>{t("diskTreemap.calculating")}</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full" style={{ color: "#f87171" }}>
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex items-center justify-center h-full opacity-40">
            <span>{t("diskTreemap.noFiles")}</span>
          </div>
        ) : (
          <svg
            width={dims.w}
            height={dims.h}
            style={{ display: "block" }}
          >
            {nodes.map((node, i) => {
              const color = COLORS[i % COLORS.length];
              const isHovered = hovered === node.path;
              const rx = node.rect.x + 1;
              const ry = node.rect.y + 1;
              const rw = Math.max(0, node.rect.w - 2);
              const rh = Math.max(0, node.rect.h - 2);
              const showLabel = rw > 40 && rh > 20;
              return (
                <g key={node.path}>
                  <rect
                    x={rx}
                    y={ry}
                    width={rw}
                    height={rh}
                    fill={color}
                    fillOpacity={isHovered ? 0.9 : 0.7}
                    stroke={isHovered ? "#fff" : "var(--kf-bg-primary)"}
                    strokeWidth={isHovered ? 2 : 1}
                    style={{ cursor: node.is_dir ? "pointer" : "default", transition: "fill-opacity 0.1s" }}
                    onMouseEnter={() => setHovered(node.path)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => {
                      if (node.is_dir) navigateTo(node.path);
                    }}
                  />
                  {showLabel && (
                    <foreignObject x={rx + 4} y={ry + 4} width={rw - 8} height={rh - 8} style={{ pointerEvents: "none" }}>
                      <div
                        className="overflow-hidden select-none"
                        style={{
                          color: "#fff",
                          textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                          fontSize: 11,
                          lineHeight: 1.3,
                        }}
                      >
                        <div className="font-semibold truncate">{node.name}</div>
                        {rh > 36 && (
                          <div style={{ opacity: 0.85, fontSize: 10 }}>{formatSize(node.size)}</div>
                        )}
                      </div>
                    </foreignObject>
                  )}
                </g>
              );
            })}
          </svg>
        )}

        {/* Hover tooltip */}
        {hovered && (() => {
          const node = nodes.find((n) => n.path === hovered);
          if (!node) return null;
          return (
            <div
              className="absolute bottom-3 left-3 px-2 py-1.5 rounded shadow-lg text-xs pointer-events-none"
              style={{
                backgroundColor: "var(--kf-bg-secondary)",
                border: "1px solid var(--kf-border)",
                maxWidth: 300,
              }}
            >
              <div className="font-semibold">{node.name}</div>
              <div style={{ color: "var(--kf-text-muted)" }}>{formatSize(node.size)}</div>
              {node.is_dir && (
                <div style={{ color: "var(--kf-accent)", fontSize: 10, marginTop: 2 }}>
                  {t("diskTreemap.clickToDrillDown")}
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
