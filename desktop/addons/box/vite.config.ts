import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.tsx"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "ui",
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
  },
});
