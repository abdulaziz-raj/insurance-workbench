import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@workbench/schema": new URL(
        "../../packages/schema/src/index.ts",
        import.meta.url
      ).pathname,
    },
  },
  server: {
    // Pinned so the workbench web always lives at a known URL (matches the API's
    // CORS allowlist). strictPort makes a conflict fail loudly instead of silently
    // drifting to another port. insurance-chat lives on 5174.
    port: 5173,
    strictPort: true,
    proxy: {
      "/ingest": "http://localhost:3001",
      "/sessions": "http://localhost:3001",
      "/rulesets": "http://localhost:3001",
      "/health": "http://localhost:3001",
      "/hello": "http://localhost:3001",
    },
  },
});
