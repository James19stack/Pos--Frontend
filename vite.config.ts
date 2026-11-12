import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Forward /api to Phoenix so the browser sees one origin (no CORS in dev).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:4000" } },
});
