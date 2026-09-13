import { Layout } from "../types/layout";

export type LayoutFormat = "json" | "yaml" | "xml";

// JSON シリアライズ
function toJson(layout: Layout): string {
  return JSON.stringify(layout, null, 2);
}

function fromJson(content: string): Layout {
  return JSON.parse(content) as Layout;
}

// YAML シリアライズ（簡易実装）
function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return obj.includes("\n") ? `|\n${obj.split("\n").map((l) => pad + "  " + l).join("\n")}` : JSON.stringify(obj);
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj.map((item) => `${pad}- ${toYaml(item, indent + 1).trimStart()}`).join("\n");
  }
  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        const val = toYaml(v, indent + 1);
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          return `${pad}${k}:\n${val}`;
        }
        if (Array.isArray(v)) {
          return `${pad}${k}:\n${val}`;
        }
        return `${pad}${k}: ${val}`;
      })
      .join("\n");
  }
  return String(obj);
}

// XML シリアライズ（簡易実装）
function toXml(obj: unknown, tag: string, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return `${pad}<${tag}/>`;
  if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") {
    const escaped = String(obj)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `${pad}<${tag}>${escaped}</${tag}>`;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => toXml(item, "item", indent)).join("\n");
  }
  if (typeof obj === "object") {
    const children = Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => toXml(v, k, indent + 1))
      .join("\n");
    return `${pad}<${tag}>\n${children}\n${pad}</${tag}>`;
  }
  return `${pad}<${tag}>${obj}</${tag}>`;
}

export function serializeLayout(layout: Layout, format: LayoutFormat): string {
  switch (format) {
    case "json":
      return toJson(layout);
    case "yaml":
      return `# shirube-filer layout\n${toYaml(layout)}`;
    case "xml":
      return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(layout, "layout")}`;
  }
}

export function deserializeLayout(content: string, format: LayoutFormat): Layout {
  switch (format) {
    case "json":
      return fromJson(content);
    case "yaml":
    case "xml":
      // YAML/XML のデシリアライズは Rust 側でパース済みの JSON を想定
      // または JSON フォールバック
      try {
        return fromJson(content);
      } catch {
        throw new Error(`${format.toUpperCase()} のデシリアライズは未対応です。JSON 形式をご利用ください。`);
      }
  }
}
