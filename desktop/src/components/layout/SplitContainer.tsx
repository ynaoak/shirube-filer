import { Fragment } from "react";
import { Group, Panel, Separator, Layout as PanelLayout } from "react-resizable-panels";
import { SplitNode } from "../../types/layout";
import { useLayout } from "../../store/layoutStore";
import LayoutRenderer from "./LayoutRenderer";

type Props = {
  split: SplitNode;
  onSelectFile: (path: string | null) => void;
};

export default function SplitContainer({ split, onSelectFile }: Props) {
  const { dispatch } = useLayout();

  const onLayoutChanged = (panelLayout: PanelLayout) => {
    const sizes = split.children.map((child) => panelLayout[child.id] ?? 0);
    dispatch({ type: "UPDATE_SIZES", nodeId: split.id, sizes });
  };

  return (
    <Group
      orientation={split.direction === "horizontal" ? "horizontal" : "vertical"}
      onLayoutChanged={onLayoutChanged}
      className="w-full h-full"
    >
      {split.children.map((child, index) => (
        <Fragment key={child.id}>
          <Panel
            id={child.id}
            defaultSize={split.sizes[index] ?? 100 / split.children.length}
            minSize={10}
            // min-w-0 / min-h-0: ペイン内コンテンツの min-content 幅が割当サイズを
            // 突き破るのを防ぐ（無いと多分割時に先頭ペインが他ペインを圧迫し、
            // ツールバーやチップ行が見切れる）
            className="min-w-0 min-h-0 overflow-hidden"
          >
            <LayoutRenderer node={child} onSelectFile={onSelectFile} />
          </Panel>
          {index < split.children.length - 1 && (
            <Separator
              className={
                split.direction === "horizontal"
                  ? "w-1 bg-neutral-700 hover:bg-blue-500 transition-colors cursor-col-resize"
                  : "h-1 bg-neutral-700 hover:bg-blue-500 transition-colors cursor-row-resize"
              }
            />
          )}
        </Fragment>
      ))}
    </Group>
  );
}
