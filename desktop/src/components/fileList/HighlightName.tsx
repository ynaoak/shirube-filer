import { memo } from "react";

// 名前中の検索クエリ一致箇所をハイライトする。
const HighlightName = memo(function HighlightName({ name, query }: { name: string; query: string }) {
  if (!query) return <>{name}</>;
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{name}</>;
  return (
    <>
      {name.slice(0, idx)}
      <mark style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)", borderRadius: 2, padding: "0 1px" }}>
        {name.slice(idx, idx + query.length)}
      </mark>
      {name.slice(idx + query.length)}
    </>
  );
});

export default HighlightName;
