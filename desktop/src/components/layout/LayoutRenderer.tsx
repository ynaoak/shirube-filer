import { LayoutNode } from "../../types/layout";
import PaneContainer from "./PaneContainer";
import SplitContainer from "./SplitContainer";

type Props = {
  node: LayoutNode;
  onSelectFile: (path: string | null) => void;
};

export default function LayoutRenderer({ node, onSelectFile }: Props) {
  if (node.type === "pane") {
    return <PaneContainer pane={node} onSelectFile={onSelectFile} />;
  }
  return <SplitContainer split={node} onSelectFile={onSelectFile} />;
}
