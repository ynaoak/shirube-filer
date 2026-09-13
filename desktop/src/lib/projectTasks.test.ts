import { describe, it, expect } from "vitest";
import { isProjectManifestFile, samePath, taskKey } from "./projectTasks";

describe("samePath", () => {
  it("末尾の区切りと / \\ の違いを無視する", () => {
    expect(samePath("/home/u/app", "/home/u/app/")).toBe(true);
    expect(samePath("C:\\dev\\app", "C:/dev/app")).toBe(true);
  });

  it("Windows のパスだけ大文字小文字を無視する", () => {
    expect(samePath("C:\\Dev\\App", "c:/dev/app")).toBe(true);
    // POSIX では App と app は別物なので畳んではいけない
    expect(samePath("/home/u/App", "/home/u/app")).toBe(false);
  });

  it("前方一致で別フォルダを取り違えない", () => {
    expect(samePath("/home/u/app", "/home/u/app2")).toBe(false);
  });
});

describe("isProjectManifestFile", () => {
  it("タスクを出せるマニフェストを見分ける", () => {
    for (const name of [
      "package.json",
      "Cargo.toml",
      "Makefile",
      "makefile",
      "GNUmakefile",
      "compose.yaml",
      "compose.yml",
      "docker-compose.yaml",
      "docker-compose.yml",
      "Dockerfile",
    ]) {
      expect(isProjectManifestFile(name), name).toBe(true);
    }
  });

  it("フルパスで渡してもファイル名だけを見る", () => {
    expect(isProjectManifestFile("/home/u/app/package.json")).toBe(true);
    expect(isProjectManifestFile("C:\\dev\\app\\Cargo.toml")).toBe(true);
  });

  it("大文字小文字は問わない（Windows では同じファイル）", () => {
    expect(isProjectManifestFile("cargo.toml")).toBe(true);
    expect(isProjectManifestFile("PACKAGE.JSON")).toBe(true);
  });

  it("関係ないファイルでは反応しない", () => {
    for (const name of [
      "Cargo.lock",
      "package-lock.json",
      "package.json.bak",
      "my-package.json",
      "Makefile.am",
      "Dockerfile.dev",
      "compose.override.yaml",
      "README.md",
      "",
    ]) {
      expect(isProjectManifestFile(name), name).toBe(false);
    }
  });
});

describe("taskKey", () => {
  const manifest = {
    kind: "node",
    file: "/home/u/app/package.json",
    tool: "pnpm",
    name: "app",
    tasks: [],
  };
  const task = {
    id: "script:build",
    label: "build",
    detail: null,
    command: "pnpm run build",
    kind: "build" as const,
    longRunning: false,
  };

  it("マニフェストとタスクの組で一意になる", () => {
    expect(taskKey(manifest, task)).toBe("/home/u/app/package.json::script:build");
    // 同名タスクでも別マニフェストなら別キー（monorepo で衝突しない）
    const other = { ...manifest, file: "/home/u/app/web/package.json" };
    expect(taskKey(other, task)).not.toBe(taskKey(manifest, task));
  });
});
