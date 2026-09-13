import { describe, it, expect } from "vitest";
import { formatSize } from "./format";

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1)).toBe("1 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("formats kilobytes at the 1024 boundary", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatSize(3.5 * 1024 * 1024 * 1024)).toBe("3.5 GB");
  });
});
