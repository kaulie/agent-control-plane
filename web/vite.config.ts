import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? "dev"),
  },
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      "/api": "http://127.0.0.1:4211",
      "/ws": { target: "ws://127.0.0.1:4211", ws: true },
    },
  },
});
