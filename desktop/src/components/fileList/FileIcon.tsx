import { FileEntry } from "../../types/fs";
import Icon from "../common/Icon";
import { useEmbeddedIcon } from "../../lib/embeddedIcons";
import { fileIconSpec, fileIconKind } from "./fileIconSpec";
import DimensionalIcon from "./DimensionalIcon";
import { useUiSettings } from "../../store/uiSettingsStore";

// ファイル種別に応じたアイコン。フォルダはアクセント色、選択行ではアクセント文字色。
export default function FileIcon({ entry, isSelected: _isSelected, size }: { entry: FileEntry; isSelected?: boolean; size?: number }) {
  // 選択時もアイコンの色彩は保持する（Finder / Explorer はネイティブで色を維持）。
  const [{ iconSet }] = useUiSettings();

  // OS シェルのアイコン。アイコンセットが "system" なら全種別で
  // Windows エクスプローラーと同じ絵柄を使い、"material" でも exe / lnk など
  // 自身がアイコンを持つファイルだけは実アイコンを表示する。
  const embedded = useEmbeddedIcon(entry, iconSet === "system");
  if (embedded) {
    const px = size ?? 16;
    return (
      <img
        src={embedded}
        alt=""
        aria-hidden
        draggable={false}
        width={px}
        height={px}
        style={{ width: px, height: px, objectFit: "contain", flexShrink: 0, pointerEvents: "none" }}
      />
    );
  }
  // 立体アイコン（グラデーションと陰影を持つ自作 SVG）。
  // 種別で見分ける役割は Material 版と同じなので、判定だけ共有する。
  if (iconSet === "dimensional") {
    return <DimensionalIcon kind={fileIconKind(entry)} size={size} />;
  }

  // 種別ごとのアイコン名・色は fileIconSpec に集約している
  // （ドラッグ中のカーソル追従画像と同じ定義を使うため）。
  const spec = fileIconSpec(entry);
  // フォルダアイコンはアクセント色。選択行はアクセント塗りのため、その上では
  // アクセント文字色に切り替えてアイコンが背景に溶けないようにする。
  // 選択行は濃い塗りなので、フォルダアイコンは白に反転させる。
  const color = entry.isDir && _isSelected ? "var(--kf-sel-fg)" : spec.color;
  return <Icon name={spec.name} size={size} style={{ color }} />;
}
