import { describe, it, expect } from "vitest";
import { serializeLayout, deserializeLayout } from "./layoutSerializer";
import type { Layout } from "../types/layout";

// 代表的なレイアウト構造（型は Workspace = Layout）。
const layout = {
  version: 1,
  groups: [
    {
      id: "g1",
      label: "Group 1",
      root: {
        type: "pane",
        id: "p1",
        tabs: [{ id: "t1", paneType: "file", title: "home", path: "/home" }],
        activeTabId: "t1",
      },
    },
  ],
  activeGroupId: "g1",
} as unknown as Layout;

describe("layoutSerializer", () => {
  it("round-trips through JSON", () => {
    const json = serializeLayout(layout, "json");
    expect(deserializeLayout(json, "json")).toEqual(layout);
  });

  it("emits a YAML document with a header and keys", () => {
    const yaml = serializeLayout(layout, "yaml");
    expect(yaml.startsWith("# shirube-filer layout")).toBe(true);
    expect(yaml).toContain("activeGroupId: \"g1\"");
  });

  it("emits an XML document with a declaration and root element", () => {
    const xml = serializeLayout(layout, "xml");
    expect(xml.startsWith("<?xml version=\"1.0\"")).toBe(true);
    expect(xml).toContain("<layout>");
    expect(xml).toContain("</layout>");
  });

  it("throws a helpful error when deserializing non-JSON content as XML", () => {
    expect(() => deserializeLayout("<layout></layout>", "xml")).toThrow();
  });
});
