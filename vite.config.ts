import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  plugins: [react()],
  build: {
    rollupOptions: { input: { main: "index.html", bench: "bench.html" } },
  },
});
