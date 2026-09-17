import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy target: same port resolution as the gateway (SERVICE_PORT → PORT → 4211).
const backendPort =
  process.env.SERVICE_PORT?.trim() || process.env.PORT?.trim() || "4211";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? "dev"),
  },
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      "/api": `http://127.0.0.1:${backendPort}`,
      "/ws": { target: `ws://127.0.0.1:${backendPort}`, ws: true },
    },
  },
});
