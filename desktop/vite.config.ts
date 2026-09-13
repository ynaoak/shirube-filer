import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 5000,
    // 27MB 近い成果物の gzip サイズ算出はビルドを数秒遅くするだけなので省く
    reportCompressedSize: false,
    // Tauri の WebView は最新エンジン（WebView2 / WKWebView）のため過剰な変換を避ける
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite が動的 import 用に注入する preload ヘルパーは、エントリが常に
          // 静的参照する。これが monaco-vendor チャンクに混ざると monaco 全体が
          // 起動時に modulepreload されてしまい遅延ロードが無効化されるため、
          // 常時ロードされる vendor 側へ明示的に固定する。
          if (id.includes("vite/preload-helper")) return "vendor";
          if (id.includes("node_modules")) {
            if (id.includes("monaco-editor")) return "monaco-vendor";
            // xterm は遅延ロードされる Terminal だけが使う。eager な vendor に
            // 混ぜると起動時に読み込まれてしまうため別チャンクに分離する。
            if (id.includes("@xterm")) return "xterm-vendor";
            // shiki の言語・テーマ定義は shikiHighlighter.ts から個別に動的 import
            // される（言語ごとに 1 ファイル、~700 言語中 数十件のみ）。ここで
            // "vendor" に丸めてしまうと、常時ロードされる vendor チャンクに全言語
            // 定義が混入して遅延ロードが無効化されるため、Rollup の既定の自動
            // チャンク分割に委ねる（= 動的 import ごとに個別の小さなチャンクになる）。
            if (id.includes("/shiki/") || id.includes("/@shikijs/")) return undefined;
            return "vendor";
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
