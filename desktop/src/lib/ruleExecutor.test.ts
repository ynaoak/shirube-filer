import { describe, it, expect, vi } from "vitest";

// ruleExecutor は @tauri-apps/api/core を読み込むため、node 環境用にモックする。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { matchesRule } from "./ruleExecutor";
import type { AutomationRule } from "../store/ruleStore";
import type { FileEntry } from "../types/fs";

const rule = (conditions: AutomationRule["conditions"]): AutomationRule => ({
  id: "r",
  name: "n",
  enabled: true,
  autoRun: false,
  watchPath: "/x",
  conditions,
  actions: [],
});

const file = (over: Partial<FileEntry> = {}): FileEntry => ({
  name: "report.txt",
  path: "/x/report.txt",
  isDir: false,
  isSymlink: false,
  isHidden: false,
  size: 100,
  modified: 0,
  extension: "txt",
  ...over,
});

describe("matchesRule", () => {
  it("never matches directories", () => {
    expect(matchesRule(rule({}), file({ isDir: true }))).toBe(false);
  });

  it("matches any file when conditions are empty", () => {
    expect(matchesRule(rule({}), file())).toBe(true);
  });

  it("filters by extension (case-insensitive)", () => {
    expect(matchesRule(rule({ extensions: ["txt", "md"] }), file({ extension: "txt" }))).toBe(true);
    expect(matchesRule(rule({ extensions: ["md"] }), file({ extension: "txt" }))).toBe(false);
    expect(matchesRule(rule({ extensions: ["txt"] }), file({ extension: "TXT" }))).toBe(true);
  });

  it("filters by name glob", () => {
    expect(matchesRule(rule({ namePattern: "report.*" }), file({ name: "report.txt" }))).toBe(true);
    expect(matchesRule(rule({ namePattern: "*.png" }), file({ name: "report.txt" }))).toBe(false);
  });

  it("filters by minimum size", () => {
    expect(matchesRule(rule({ minSize: 50 }), file({ size: 100 }))).toBe(true);
    expect(matchesRule(rule({ minSize: 200 }), file({ size: 100 }))).toBe(false);
  });

  it("requires all conditions to pass", () => {
    const r = rule({ extensions: ["txt"], namePattern: "report.*", minSize: 50 });
    expect(matchesRule(r, file())).toBe(true);
    expect(matchesRule(r, file({ size: 10 }))).toBe(false);
    expect(matchesRule(r, file({ name: "notes.txt", path: "/x/notes.txt" }))).toBe(false);
  });
});
