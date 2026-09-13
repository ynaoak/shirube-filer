import { defineConfig } from "vitest/config";

// 純粋ロジックの単体テスト用。UI/Tauri を伴わないので node 環境で十分。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
